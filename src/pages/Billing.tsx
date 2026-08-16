import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import SiteNav from "../components/SiteNav";
import StripeElementsForm from "../components/billing/StripeElementsForm";
import { apiFetch } from "../lib/api";

type BillingSummary = {
  subscription: {
    status: string;
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: string | null;
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

const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  trialing: "Active",
  past_due: "Past due",
  unpaid: "Past due",
  canceled: "Canceled",
  incomplete: "Awaiting payment",
  incomplete_expired: "Canceled",
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
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
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [updatingCard, setUpdatingCard] = useState(false);
  const [setupClientSecret, setSetupClientSecret] = useState<string | null>(
    null,
  );

  const load = useCallback(async (): Promise<BillingSummary | null> => {
    setLoading(true);
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
      const response = await apiFetch("/api/billing?action=cancel-subscription", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resume }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error ?? "Could not update your subscription.");
        setBusy(false);
        return;
      }
      await load();
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
      const response = await apiFetch("/api/billing?action=create-setup-intent", {
        method: "POST",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.clientSecret) {
        setError(payload?.error ?? "Could not start payment method update.");
        setBusy(false);
        return;
      }
      setSetupClientSecret(payload.clientSecret);
      setUpdatingCard(true);
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
    setUpdatingCard(false);
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
  }

  const subscription = summary?.subscription ?? null;
  const statusLabel = subscription
    ? (STATUS_LABEL[subscription.status] ?? subscription.status)
    : null;

  return (
    <main className="account-page billing-page">
      <SiteNav />

      <section className="account-main">
        <header className="account-header">
          <p className="eyebrow">My account</p>
          <h1>Billing</h1>
        </header>

        {loading ? (
          <p className="account-empty">Loading your billing information…</p>
        ) : !subscription ? (
          <div className="account-empty">
            <p>You don't have an active subscription yet.</p>
            <button type="button" onClick={() => navigate("/pricing")}>
              View plans <span>→</span>
            </button>
          </div>
        ) : (
          <>
            <div className="billing-card">
              <div className="billing-card-row">
                <div>
                  <span className="billing-card-label">Plan</span>
                  <strong>Audition Plus — $7/month</strong>
                </div>
                <span className="billing-status-pill">{statusLabel}</span>
              </div>

              <div className="billing-card-row">
                <div>
                  <span className="billing-card-label">
                    {subscription.cancelAtPeriodEnd
                      ? "Access ends"
                      : "Next renewal"}
                  </span>
                  <strong>{formatDate(subscription.currentPeriodEnd)}</strong>
                </div>
              </div>

              <div className="billing-card-row">
                <div>
                  <span className="billing-card-label">Payment method</span>
                  <strong>
                    {subscription.card
                      ? `${subscription.card.brand.replace(/^\w/, (c) => c.toUpperCase())} •••• ${subscription.card.last4}`
                      : "No card on file"}
                  </strong>
                </div>
              </div>

              {updatingCard && setupClientSecret ? (
                <StripeElementsForm
                  clientSecret={setupClientSecret}
                  submitLabel="Save card"
                  onCancel={() => {
                    setUpdatingCard(false);
                    setSetupClientSecret(null);
                  }}
                  onConfirmed={confirmCardUpdate}
                />
              ) : (
                <div className="billing-card-actions">
                  <button
                    type="button"
                    onClick={startCardUpdate}
                    disabled={busy}
                  >
                    Update payment method
                  </button>
                  {subscription.cancelAtPeriodEnd ? (
                    <button
                      type="button"
                      onClick={() => toggleCancel(true)}
                      disabled={busy}
                    >
                      Resume plan
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => toggleCancel(false)}
                      disabled={busy}
                    >
                      Cancel plan
                    </button>
                  )}
                </div>
              )}

              {error && (
                <p className="plan-error" role="alert">
                  {error}
                </p>
              )}
            </div>

            {summary && summary.invoices.length > 0 && (
              <div className="billing-history">
                <h2>Billing history</h2>
                <ul>
                  {summary.invoices.map((invoice) => (
                    <li key={invoice.id}>
                      <span>{formatDate(invoice.created)}</span>
                      <span>
                        {formatMoney(invoice.amountPaid, invoice.currency)}
                      </span>
                      <span className="billing-history-status">
                        {invoice.status ?? "—"}
                      </span>
                      {invoice.hostedInvoiceUrl ? (
                        <a
                          href={invoice.hostedInvoiceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Receipt
                        </a>
                      ) : (
                        <span />
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}
