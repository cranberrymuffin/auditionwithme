import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Modal from "../components/Modal";
import Seo from "../components/Seo";
import SiteNav from "../components/SiteNav";
import StripeElementsForm from "../components/billing/StripeElementsForm";
import { apiFetch } from "../lib/api";
import { useToast } from "../lib/toast";
import { TRIAL_DAYS, formatPlanPrice } from "../lib/plan";

type BillingSummary = {
  trialEligible: boolean;
  subscription: {
    status: string;
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: string | null;
    trialEnd: string | null;
    endedAt: string | null;
    plan: { amount: number; currency: string; interval: string } | null;
    card: { brand: string; last4: string } | null;
  } | null;
  invoices: {
    id: string;
    created: string;
    amountPaid: number;
    currency: string;
    status: string | null;
    hostedInvoiceUrl: string | null;
  }[];
};

type Tone = "trial" | "active" | "warning" | "ended";

const STATUS: Record<string, { label: string; tone: Tone }> = {
  trialing: { label: "Free trial", tone: "trial" },
  active: { label: "Active", tone: "active" },
  past_due: { label: "Payment failed", tone: "warning" },
  unpaid: { label: "Payment failed", tone: "warning" },
  incomplete: { label: "Awaiting payment", tone: "warning" },
  canceled: { label: "Ended", tone: "ended" },
  incomplete_expired: { label: "Ended", tone: "ended" },
};

const BRAND_LABEL: Record<string, string> = {
  amex: "American Express",
  diners: "Diners Club",
  discover: "Discover",
  jcb: "JCB",
  mastercard: "Mastercard",
  unionpay: "UnionPay",
  visa: "Visa",
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amount / 100);
}

// The webhook, not the confirm() call, is what actually attaches the new
// default payment method — so poll briefly after confirming before assuming
// the update landed (same pattern as Pricing.tsx's subscription confirm).
const CONFIRM_POLL_MS = 1500;
const CONFIRM_TIMEOUT_MS = 10000;

export default function Billing() {
  const navigate = useNavigate();
  const toast = useToast();
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [setupClientSecret, setSetupClientSecret] = useState<string | null>(
    null,
  );

  const load = useCallback(async (): Promise<BillingSummary | null> => {
    try {
      const response = await apiFetch("/api/billing");
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error ?? "Could not load your billing information.");
        return null;
      }
      setSummary(payload as BillingSummary);
      setError(null);
      return payload as BillingSummary;
    } catch {
      setError("Could not load your billing information.");
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function toggleCancel(resume: boolean) {
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch(
        "/api/billing?action=cancel-subscription",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ resume }),
        },
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error ?? "Could not update your subscription.");
        return;
      }
      setConfirmingCancel(false);
      await load();
      toast(resume ? "Your plan will keep renewing." : "Your plan is canceled.");
    } catch {
      setError("Could not update your subscription.");
    } finally {
      setBusy(false);
    }
  }

  async function startCardUpdate() {
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch(
        "/api/billing?action=create-setup-intent",
        { method: "POST" },
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.clientSecret) {
        setError(payload?.error ?? "Could not start payment method update.");
        return;
      }
      setSetupClientSecret(payload.clientSecret);
    } catch {
      setError("Could not start payment method update.");
    } finally {
      setBusy(false);
    }
  }

  // Confirming a setup-mode Checkout Session doesn't hand back a payment
  // method id — the webhook (checkout.session.completed) attaches it as the
  // default asynchronously, so poll briefly until the new card shows up.
  async function confirmCardUpdate() {
    setSetupClientSecret(null);
    setBusy(true);
    const previousCard = summary?.subscription?.card ?? null;
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    let latest = await load();
    while (
      Date.now() < deadline &&
      (!latest?.subscription?.card ||
        (previousCard &&
          latest.subscription.card.brand === previousCard.brand &&
          latest.subscription.card.last4 === previousCard.last4))
    ) {
      await new Promise((resolve) => setTimeout(resolve, CONFIRM_POLL_MS));
      latest = await load();
    }
    setBusy(false);
    toast("Payment method updated.");
  }

  const subscription = summary?.subscription ?? null;
  const status = subscription
    ? (STATUS[subscription.status] ?? {
        label: subscription.status,
        tone: "warning" as Tone,
      })
    : null;
  const isTrial = subscription?.status === "trialing";
  const hasEnded = status?.tone === "ended";
  const price = subscription?.plan
    ? `${formatPlanPrice(subscription.plan)}/${subscription.plan.interval}`
    : null;
  const amount = subscription?.plan ? formatPlanPrice(subscription.plan) : "your plan price";
  const periodEnd = formatDate(
    isTrial ? subscription?.trialEnd ?? null : subscription?.currentPeriodEnd ?? null,
  );
  const card = subscription?.card
    ? `${BRAND_LABEL[subscription.card.brand] ?? subscription.card.brand} ending in ${subscription.card.last4}`
    : null;

  let headline: string | null = null;
  if (subscription && status) {
    if (hasEnded) {
      headline = `Your plan ended on ${formatDate(subscription.endedAt ?? subscription.currentPeriodEnd)}.`;
    } else if (status.tone === "warning") {
      headline =
        "We couldn't charge your card. Update your payment method to keep rehearsing.";
    } else if (isTrial && subscription.cancelAtPeriodEnd) {
      headline = `Your free trial ends ${periodEnd}, and you won't be charged.`;
    } else if (isTrial) {
      headline = `Your free trial ends ${periodEnd}. After that it's ${amount} a month${card ? `, charged to your ${card}` : ""}.`;
    } else if (subscription.cancelAtPeriodEnd) {
      headline = `Your plan ends ${periodEnd}. You won't be charged again.`;
    } else {
      headline = `Your plan renews ${periodEnd} for ${amount}.`;
    }
  }

  return (
    <main className="account-page billing-page">
      <Seo
        title="Billing"
        description="Manage your Audition Plus subscription and billing history."
        path="/billing"
        noindex
      />
      <SiteNav />

      <section className="account-main">
        <header className="account-header">
          <h1>Billing</h1>
          <p className="account-email">
            Your plan, payment method, and receipts.
          </p>
        </header>

        {loading ? (
          <div className="billing-card is-loading" aria-busy="true">
            <span className="billing-skeleton is-wide" />
            <span className="billing-skeleton" />
            <span className="billing-skeleton is-short" />
          </div>
        ) : !subscription ? (
          <div className="billing-empty">
            <p className="billing-empty-eyebrow">No plan yet</p>
            <h2>
              {summary?.trialEligible === false
                ? "Pick up where you left off."
                : `Rehearse free for ${TRIAL_DAYS} days.`}
            </h2>
            <p>
              Audition Plus gives you unlimited rehearsals with AI scene
              partners. Cancel anytime from this page.
            </p>
            <button type="button" onClick={() => navigate("/pricing")}>
              {summary?.trialEligible === false
                ? "See the plan"
                : "Start your free trial"}{" "}
              <span aria-hidden="true">→</span>
            </button>
            {error && (
              <p className="plan-error" role="alert">
                {error}
              </p>
            )}
          </div>
        ) : (
          <>
            <article className={`billing-card tone-${status?.tone}`}>
              <header className="billing-card-header">
                <div>
                  <span className="billing-card-label">Your plan</span>
                  <h2>Audition Plus</h2>
                  {price && <p className="billing-card-price">{price}</p>}
                </div>
                <span className={`billing-status-pill tone-${status?.tone}`}>
                  {subscription.cancelAtPeriodEnd && !hasEnded
                    ? "Canceling"
                    : status?.label}
                </span>
              </header>

              {headline && (
                <p
                  className={`billing-headline ${status?.tone === "warning" ? "is-warning" : ""}`}
                  role={status?.tone === "warning" ? "alert" : undefined}
                >
                  {headline}
                </p>
              )}

              {!hasEnded && (
                <dl className="billing-facts">
                  <div>
                    <dt>
                      {subscription.cancelAtPeriodEnd
                        ? "Access until"
                        : isTrial
                          ? "First charge"
                          : "Next charge"}
                    </dt>
                    <dd>{periodEnd}</dd>
                  </div>
                  <div>
                    <dt>Payment method</dt>
                    <dd className="billing-card-number">
                      {subscription.card ? (
                        <>
                          <span className="billing-brand" aria-hidden="true">
                            {(BRAND_LABEL[subscription.card.brand] ??
                              subscription.card.brand)
                              .slice(0, 4)
                              .toUpperCase()}
                          </span>
                          <span>•••• {subscription.card.last4}</span>
                        </>
                      ) : (
                        "No card on file"
                      )}
                    </dd>
                  </div>
                </dl>
              )}

              <div className="billing-card-actions">
                {hasEnded ? (
                  <button
                    type="button"
                    className="is-primary"
                    onClick={() => navigate("/pricing")}
                  >
                    Resubscribe <span aria-hidden="true">→</span>
                  </button>
                ) : (
                  <>
                    {subscription.cancelAtPeriodEnd ? (
                      <button
                        type="button"
                        className="is-primary"
                        onClick={() => toggleCancel(true)}
                        disabled={busy}
                      >
                        {isTrial ? "Keep my plan after the trial" : "Resume plan"}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={status?.tone === "warning" ? "is-primary" : ""}
                      onClick={startCardUpdate}
                      disabled={busy}
                    >
                      Update payment method
                    </button>
                    {!subscription.cancelAtPeriodEnd && (
                      <button
                        type="button"
                        className="is-quiet"
                        onClick={() => setConfirmingCancel(true)}
                        disabled={busy}
                      >
                        {isTrial ? "Cancel trial" : "Cancel plan"}
                      </button>
                    )}
                  </>
                )}
              </div>

              {error && (
                <p className="plan-error" role="alert">
                  {error}
                </p>
              )}
            </article>

            {confirmingCancel && (
              <Modal
                onClose={() => setConfirmingCancel(false)}
                labelledBy="cancel-modal-title"
                className="is-compact"
              >
                <h2 id="cancel-modal-title" className="modal-title">
                  {isTrial ? "Cancel your free trial?" : "Cancel Audition Plus?"}
                </h2>
                <p className="modal-copy">
                  {isTrial
                    ? `You can keep rehearsing until ${periodEnd}. You won't be charged.`
                    : `You can keep rehearsing until ${periodEnd}. You won't be charged again.`}{" "}
                  You can change your mind anytime before then.
                </p>
                <div className="modal-actions">
                  <button
                    type="button"
                    className="modal-secondary"
                    onClick={() => setConfirmingCancel(false)}
                    data-autofocus
                  >
                    Keep my plan
                  </button>
                  <button
                    type="button"
                    className="modal-danger"
                    onClick={() => toggleCancel(false)}
                    disabled={busy}
                  >
                    {busy ? "Canceling…" : isTrial ? "Cancel trial" : "Cancel plan"}
                  </button>
                </div>
              </Modal>
            )}

            {setupClientSecret && (
              <Modal
                onClose={() => setSetupClientSecret(null)}
                labelledBy="update-card-modal-title"
              >
                <h2 id="update-card-modal-title" className="modal-title">
                  Update payment method
                </h2>
                <StripeElementsForm
                  clientSecret={setupClientSecret}
                  submitLabel="Save card"
                  onCancel={() => setSetupClientSecret(null)}
                  onConfirmed={confirmCardUpdate}
                />
              </Modal>
            )}

            {summary && summary.invoices.length > 0 && (
              <section className="billing-history" aria-labelledby="billing-history-title">
                <h2 id="billing-history-title">Billing history</h2>
                <ul>
                  {summary.invoices.map((invoice) => (
                    <li key={invoice.id}>
                      <span>{formatDate(invoice.created)}</span>
                      <span className="billing-history-amount">
                        {invoice.amountPaid === 0 && invoice.status === "paid"
                          ? "Free trial"
                          : formatMoney(invoice.amountPaid, invoice.currency)}
                      </span>
                      <span
                        className={`billing-history-status is-${invoice.status ?? "unknown"}`}
                      >
                        {invoice.status ?? "—"}
                      </span>
                      {invoice.hostedInvoiceUrl ? (
                        <a
                          href={invoice.hostedInvoiceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Receipt<span className="sr-only"> (opens in a new tab)</span>
                        </a>
                      ) : (
                        <span />
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </section>
    </main>
  );
}
