import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import SiteNav from "../components/SiteNav";
import { apiFetch } from "../lib/api";
import { useAuth } from "../contexts/AuthContext";
import { useEntitlement } from "../hooks/useEntitlement";

const features = [
  "Choose a voice for every character",
  "Rehearse complete scripts",
  "Follow dialogue word by word",
  "Save your selected role and setup",
  "Replay scenes throughout your plan",
];

const questions = [
  [
    "What counts as a rehearsal session?",
    "One uploaded PDF prepared as a new rehearsal. Replaying or revisiting that same rehearsal does not create another session.",
  ],
  [
    "Do I need a credit card to start?",
    "No. Your first three rehearsal sessions are included without a credit card.",
  ],
  [
    "What happens after my free sessions?",
    "You can continue creating new rehearsals with Audition Plus for $7 per month.",
  ],
  [
    "Can I cancel anytime?",
    "Yes. The plan renews monthly, and you can cancel before your next renewal.",
  ],
  [
    "What files can I upload?",
    "The rehearsal parser currently accepts PDF audition sides and scripts.",
  ],
  [
    "How is my script handled?",
    "Your PDF is processed to identify dialogue, characters, and scene directions needed for the rehearsal.",
  ],
];

// The webhook, not the redirect back from Stripe, is what flips
// subscription_status — so poll briefly before showing the final state.
const CONFIRM_POLL_MS = 1500;
const CONFIRM_TIMEOUT_MS = 10000;

export default function Pricing() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const { entitlement, loading, refresh } = useEntitlement();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(
    searchParams.get("checkout") === "success",
  );
  const [pendingSubscription, setPendingSubscription] = useState(false);

  const isSubscribed =
    entitlement?.subscription_status === "active" || pendingSubscription;
  const freeSessionsRemaining = entitlement
    ? Math.max(
        entitlement.free_sessions_limit - entitlement.free_sessions_used,
        0,
      )
    : 0;
  const hasFreeSessions = entitlement
    ? entitlement.subscription_status === "active" || freeSessionsRemaining > 0
    : false;
  const freeSessionCopy = loading
    ? "Checking your free sessions…"
    : entitlement
      ? entitlement.subscription_status === "active"
        ? "You have an active subscription."
        : `${freeSessionsRemaining} session${freeSessionsRemaining === 1 ? "" : "s"} left`
      : "3 sessions included. No credit card required.";

  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  });

  useEffect(() => {
    if (!confirming) return;
    setPendingSubscription(true);
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    const timer = setInterval(() => {
      if (Date.now() > deadline) {
        setConfirming(false);
        return;
      }
      refreshRef.current();
    }, CONFIRM_POLL_MS);
    return () => clearInterval(timer);
  }, [confirming]);

  useEffect(() => {
    if (isSubscribed) {
      setConfirming(false);
      setPendingSubscription(false);
    }
  }, [isSubscribed]);

  // Both CTAs work the same way: ask the server for a Stripe-hosted URL, then
  // hand the browser over to Stripe.
  async function redirectToStripe(path: string, fallbackMessage: string) {
    if (!user) {
      navigate("/login", { state: { from: "/pricing" } });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch(path, { method: "POST" });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.url) {
        setError(payload?.error ?? fallbackMessage);
        setBusy(false);
        return;
      }
      window.location.href = payload.url;
    } catch {
      setError(fallbackMessage);
      setBusy(false);
    }
  }

  return (
    <main className="pricing-page">
      <SiteNav />

      <section className="pricing-main">
        <div className="pricing-intro">
          <p>One simple plan</p>
          <h1>Simple pricing for serious rehearsal</h1>
          <div>
            Start with three free sessions. Upgrade only when rehearsal becomes
            part of your routine.
          </div>
          <ul className="pricing-reassurance">
            <li>
              <span>✓</span>No credit card to start
            </li>
            <li>
              <span>✓</span>Cancel anytime
            </li>
            <li>
              <span>✓</span>PDF scripts supported
            </li>
          </ul>
        </div>

        <article className="pricing-card">
          <header>
            <div>
              <p>Audition Plus</p>
              <span>For regular scene work</span>
            </div>
            <span>One plan</span>
          </header>
          <p className="plan-description">
            Everything you need to rehearse complete scenes with a responsive
            scene partner.
          </p>
          <p className="plan-price" aria-label="Seven dollars per month">
            <strong>$7</strong>
            <span>/month</span>
          </p>

          <ul>
            {features.map((feature) => (
              <li key={feature}>
                <span aria-hidden="true">✓</span>
                {feature}
              </li>
            ))}
          </ul>
          {isSubscribed ? (
            <button
              onClick={() =>
                redirectToStripe(
                  "/api/create-portal-session",
                  "Could not open the billing portal. Please try again.",
                )
              }
              disabled={busy}
            >
              {busy ? (
                "Opening…"
              ) : (
                <>
                  Manage subscription <span>→</span>
                </>
              )}
            </button>
          ) : hasFreeSessions ? (
            <button
              type="button"
              onClick={() => navigate("/#upload")}
              disabled={busy}
            >
              {freeSessionCopy} <span>→</span>
            </button>
          ) : (
            <button
              onClick={() =>
                redirectToStripe(
                  "/api/create-checkout-session",
                  "Could not start checkout. Please try again.",
                )
              }
              disabled={busy || confirming}
            >
              {confirming ? (
                "Confirming your subscription…"
              ) : busy ? (
                "Redirecting…"
              ) : (
                <>
                  Subscribe to keep rehearsing <span>→</span>
                </>
              )}
            </button>
          )}
          {error && (
            <p className="plan-error" role="alert">
              {error}
            </p>
          )}
        </article>
      </section>

      <section className="pricing-details" aria-labelledby="pricing-questions">
        <header>
          <p>Before you begin</p>
          <h2 id="pricing-questions">Plan details</h2>
        </header>
        <div>
          {questions.map(([question, answer], index) => (
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
        <span>
          Questions about the plan? Contact support before subscribing.
        </span>
      </footer>
    </main>
  );
}
