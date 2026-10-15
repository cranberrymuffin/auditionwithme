import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import Modal from "../components/Modal";
import Seo from "../components/Seo";
import SiteNav from "../components/SiteNav";
import StripeElementsForm from "../components/billing/StripeElementsForm";
import { apiFetch } from "../lib/api";
import { useAuth } from "../contexts/AuthContext";
import { useEntitlement } from "../hooks/useEntitlement";
import { usePlan } from "../hooks/usePlan";
import { TRIAL_DAYS, formatPlanPrice, hasPlanAccess } from "../lib/plan";

const features = [
  "Unlimited rehearsals of any script or sides",
  "A distinct voice for every character",
  "Live line tracking as you speak",
  "Self-tape recording on camera",
  "Your scripts and setups saved on your device",
];

// The webhook, not the redirect back from Stripe, is what flips
// subscription_status — so poll briefly before showing the final state.
const CONFIRM_POLL_MS = 1500;
const CONFIRM_TIMEOUT_MS = 15000;

function dayFromNow(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toLocaleDateString(undefined, { month: "long", day: "numeric" });
}

export default function Pricing() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const { entitlement, refresh } = useEntitlement();
  const plan = usePlan();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  // "redirect_status" is what Stripe appends to return_url for payment
  // methods that require an actual browser redirect (e.g. some 3DS bank
  // flows) even under redirect: "if_required".
  const [confirming, setConfirming] = useState(
    searchParams.get("redirect_status") === "succeeded",
  );
  const [justSubscribed, setJustSubscribed] = useState(false);

  const isSubscribed = hasPlanAccess(entitlement?.subscription_status);
  // The trial is for a first subscription only (api/billing.ts enforces it;
  // this just keeps the copy honest). Any past subscription leaves its ID.
  const trialEligible = !entitlement?.stripe_subscription_id;
  const trialDays = plan?.trialDays ?? TRIAL_DAYS;
  const price = plan ? formatPlanPrice(plan) : null;
  const interval = plan?.interval ?? "month";
  const trialEndLabel = dayFromNow(trialDays);

  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  });

  useEffect(() => {
    if (!confirming) return;
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    const timer = setInterval(() => {
      if (Date.now() > deadline) {
        setConfirming(false);
        setError(
          "Your payment went through, but we're still waiting on confirmation. Refresh in a minute — if this persists, contact support.",
        );
        return;
      }
      refreshRef.current();
    }, CONFIRM_POLL_MS);
    return () => clearInterval(timer);
  }, [confirming]);

  useEffect(() => {
    if (confirming && isSubscribed) {
      setConfirming(false);
      setJustSubscribed(true);
    }
  }, [confirming, isSubscribed]);

  // Starts a subscription server-side and reveals the embedded Payment
  // Element in a modal — the user never leaves this page.
  async function startSubscription() {
    if (!user) {
      navigate("/signup", { state: { from: { pathname: "/pricing" } } });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch(
        "/api/billing?action=create-subscription",
        { method: "POST" },
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.clientSecret) {
        setError(
          payload?.error ?? "Could not start checkout. Please try again.",
        );
        return;
      }
      setClientSecret(payload.clientSecret);
    } catch {
      setError("Could not start checkout. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const offerTrial = !isSubscribed && trialEligible;
  const ctaLabel = !user
    ? `Start your ${trialDays}-day free trial`
    : offerTrial
      ? `Start ${trialDays}-day free trial`
      : "Subscribe";

  const intro = justSubscribed
    ? {
        eyebrow: "You're in",
        title: "Welcome to Audition Plus.",
        sub: "Your plan is active. Upload a script and pick up your first scene — every rehearsal is unlimited from here.",
      }
    : isSubscribed
      ? {
          eyebrow: "Your plan",
          title: "You're on Audition Plus.",
          sub: "Rehearsals are unlimited while your plan is active. Manage your card, renewal, and receipts from Billing.",
        }
      : confirming
        ? {
            eyebrow: "Almost there",
            title: "Confirming your plan…",
            sub: "Stripe is confirming your subscription — this usually takes a few seconds.",
          }
        : offerTrial
          ? {
              eyebrow: "Audition Plus",
              title: `Rehearse free for ${trialDays} days.`,
              sub: `Every feature, unlimited rehearsals, no commitment. If it isn't part of your routine by ${trialEndLabel}, cancel and you won't pay a thing.`,
            }
          : {
              eyebrow: "Audition Plus",
              title: "Pick up where you left off.",
              sub: "Your saved scripts and setups are still on this device. Subscribe to keep rehearsing them — and anything new that comes in.",
            };

  return (
    <main className="pricing-page">
      <Seo
        title="Pricing"
        description={`Try Audition Plus free for ${trialDays} days — unlimited rehearsals with AI scene partners. Cancel anytime.`}
        path="/pricing"
      />
      <SiteNav />

      <section className="pricing-main">
        <div className="pricing-intro">
          <p>{intro.eyebrow}</p>
          <h1>{intro.title}</h1>
          <div>{intro.sub}</div>

          {offerTrial && !confirming && (
            <ol className="trial-timeline" aria-label="How the free trial works">
              <li>
                <span className="trial-timeline-dot" aria-hidden="true" />
                <strong>Today</strong>
                <p>Full access starts the moment you add a card.</p>
              </li>
              <li>
                <span className="trial-timeline-dot" aria-hidden="true" />
                <strong>Anytime before {trialEndLabel}</strong>
                <p>Cancel from Billing in two clicks — you won't be charged.</p>
              </li>
              <li>
                <span className="trial-timeline-dot" aria-hidden="true" />
                <strong>{trialEndLabel}</strong>
                <p>
                  {price ? `${price}/${interval}` : "Your plan"} begins. Cancel
                  anytime after that, too.
                </p>
              </li>
            </ol>
          )}

          {(isSubscribed || justSubscribed) && (
            <div className="pricing-intro-actions">
              <button
                type="button"
                className="pricing-primary"
                onClick={() => navigate("/#upload")}
              >
                Upload a script <span aria-hidden="true">→</span>
              </button>
              <button
                type="button"
                className="pricing-secondary"
                onClick={() => navigate("/billing")}
              >
                Manage billing
              </button>
            </div>
          )}
        </div>

        <article
          className={`pricing-card ${isSubscribed ? "is-current" : ""}`}
          aria-labelledby="plan-name"
        >
          <header>
            <div>
              <p id="plan-name">Audition Plus</p>
              <span>For actors with auditions on the calendar</span>
            </div>
            {isSubscribed ? (
              <span className="pricing-badge is-current">Current plan</span>
            ) : (
              offerTrial && (
                <span className="pricing-badge">{trialDays} days free</span>
              )
            )}
          </header>

          <p
            className={`plan-price ${price ? "" : "is-loading"}`}
            aria-label={price ? `${price} per ${interval}` : "Loading price"}
          >
            <strong>{price ?? "$—"}</strong>
            <span>/{interval}</span>
          </p>
          <p className="plan-price-note">
            {offerTrial
              ? `after your ${trialDays}-day free trial`
              : "billed monthly · cancel anytime"}
          </p>

          <ul>
            {features.map((feature) => (
              <li key={feature}>
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M3.5 8.5l3 3 6-7" />
                </svg>
                {feature}
              </li>
            ))}
          </ul>

          {isSubscribed ? (
            <button type="button" onClick={() => navigate("/billing")}>
              Manage subscription <span aria-hidden="true">→</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={startSubscription}
              disabled={busy || confirming}
            >
              {confirming ? (
                <>
                  <span className="billing-spinner" aria-hidden="true" />
                  Confirming…
                </>
              ) : busy ? (
                <>
                  <span className="billing-spinner" aria-hidden="true" />
                  Opening checkout…
                </>
              ) : (
                <>
                  {ctaLabel} <span aria-hidden="true">→</span>
                </>
              )}
            </button>
          )}

          {!isSubscribed && (
            <p className="pricing-fineprint">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <rect x="3" y="7" width="10" height="7" rx="1.5" />
                <path d="M5.5 7V5a2.5 2.5 0 015 0v2" />
              </svg>
              {offerTrial
                ? "$0 due today · Secure checkout by Stripe"
                : "Secure checkout by Stripe · Cancel anytime"}
            </p>
          )}

          {error && (
            <p className="plan-error" role="alert">
              {error}
            </p>
          )}
        </article>
      </section>

      {clientSecret && (
        <Modal
          onClose={() => setClientSecret(null)}
          labelledBy="checkout-modal-title"
          className="checkout-modal"
        >
          <h2 id="checkout-modal-title" className="modal-title">
            {offerTrial ? "Start your free trial" : "Subscribe to Audition Plus"}
          </h2>
          <StripeElementsForm
            clientSecret={clientSecret}
            submitLabel={offerTrial ? "Start free trial" : "Subscribe"}
            showTotal
            onCancel={() => setClientSecret(null)}
            onConfirmed={() => {
              setClientSecret(null);
              setConfirming(true);
            }}
          />
          <p className="checkout-secure-note">
            Payments are processed securely by Stripe. Audition With Me never
            sees your card number.
          </p>
        </Modal>
      )}

      <section className="pricing-details" aria-labelledby="pricing-questions">
        <header>
          <p>Before you begin</p>
          <h2 id="pricing-questions">Plan details</h2>
        </header>
        <div>
          {[
            [
              "How does the free trial work?",
              `Your first ${trialDays} days of Audition Plus are free. You add a card to start, and you're only charged ${price ? `${price}/${interval}` : "the monthly price"} if you keep your plan past the trial.`,
            ],
            [
              "Will I be charged if I cancel during the trial?",
              "No. Cancel from Billing any time before your trial ends and you won't be charged at all. You keep access until the trial's last day.",
            ],
            [
              "Can I cancel after the trial?",
              "Yes. The plan renews monthly and you can cancel whenever you like — you keep access through the end of the month you've paid for.",
            ],
            [
              "What counts as a rehearsal?",
              "Each script you upload and prepare. With Audition Plus they're unlimited, and replaying a scene never counts again.",
            ],
            [
              "What files can I upload?",
              "PDF audition sides and full scripts, including scanned pages.",
            ],
            [
              "Where is my script stored?",
              "Your scripts and self-tapes are saved on your device. The PDF is processed only to identify characters, dialogue, and directions for your rehearsal.",
            ],
          ].map(([question, answer], index) => (
            <details key={question} open={index === 0}>
              <summary>
                {question}
                <span aria-hidden="true">+</span>
              </summary>
              <p>{answer}</p>
            </details>
          ))}
        </div>
      </section>

      <footer className="pricing-footer">
        <span>Audition With Me</span>
        <span>Questions about the plan? Contact support before subscribing.</span>
      </footer>
    </main>
  );
}
