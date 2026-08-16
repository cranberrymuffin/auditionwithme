import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import SiteNav from "../components/SiteNav";
import StripeElementsForm from "../components/billing/StripeElementsForm";
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
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  // "checkout=success" covered the old Checkout redirect; "redirect_status"
  // is what Stripe appends to return_url for payment methods that require an
  // actual browser redirect (e.g. some 3DS bank flows) even under
  // redirect: "if_required".
  const [confirming, setConfirming] = useState(
    searchParams.get("checkout") === "success" ||
      searchParams.get("redirect_status") === "succeeded",
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
  const sessionsExhausted =
    !!entitlement &&
    entitlement.subscription_status !== "active" &&
    freeSessionsRemaining === 0;

  // The intro reads differently depending on who's looking at it: a visitor
  // gets acquisition copy, a signed-in user gets their real session count, a
  // subscriber (including the post-checkout confirming window) gets plan info.
  const intro = isSubscribed
    ? {
        eyebrow: "Your plan",
        title: "You're on Audition Plus",
        sub: confirming
          ? "We're confirming your subscription with Stripe — this usually takes a few seconds."
          : "New rehearsals are unlimited while your plan is active. Manage billing anytime from the card below.",
        reassurance: [
          "Cancel anytime",
          "Billing handled securely by Stripe",
          "PDF scripts supported",
        ],
      }
    : user && sessionsExhausted
      ? {
          eyebrow: "One simple plan",
          title: `You've used all ${entitlement.free_sessions_limit} free sessions`,
          sub: "Subscribe to Audition Plus to keep creating new rehearsals and pick up right where you left off.",
          reassurance: [
            "Cancel anytime",
            "Your saved scripts stay available",
            "PDF scripts supported",
          ],
        }
      : user && entitlement
        ? {
            eyebrow: "One simple plan",
            title: `You have ${freeSessionsRemaining} of ${entitlement.free_sessions_limit} free sessions left`,
            sub: "Keep rehearsing free, or subscribe now — new rehearsals become unlimited the moment you do.",
            reassurance: [
              "Cancel anytime",
              "Unused free sessions stay yours",
              "PDF scripts supported",
            ],
          }
        : {
            eyebrow: "One simple plan",
            title: "Simple pricing for serious rehearsal",
            sub:
              user && loading
                ? "Checking your free sessions…"
                : "Start with three free sessions. Upgrade only when rehearsal becomes part of your routine.",
            reassurance: [
              "No credit card to start",
              "Cancel anytime",
              "PDF scripts supported",
            ],
          };

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

  // Starts a subscription server-side and reveals the embedded Payment
  // Element inline — the user never leaves this page.
  async function startSubscription() {
    if (!user) {
      navigate("/login", { state: { from: "/pricing" } });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch("/api/billing?action=create-subscription", {
        method: "POST",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.clientSecret) {
        setError(payload?.error ?? "Could not start checkout. Please try again.");
        setBusy(false);
        return;
      }
      setClientSecret(payload.clientSecret);
      setBusy(false);
    } catch {
      setError("Could not start checkout. Please try again.");
      setBusy(false);
    }
  }

  return (
    <main className="pricing-page">
      <SiteNav />

      <section className="pricing-main">
        <div className="pricing-intro">
          <p>{intro.eyebrow}</p>
          <h1>{intro.title}</h1>
          <div>{intro.sub}</div>
          <ul className="pricing-reassurance">
            {intro.reassurance.map((item) => (
              <li key={item}>
                <span>✓</span>
                {item}
              </li>
            ))}
          </ul>
        </div>

        <article className="pricing-card">
          <header>
            <div>
              <p>Audition Plus</p>
              <span>For regular scene work</span>
            </div>
          </header>
          <p className="plan-description">
            Everything you need to rehearse complete scenes with a responsive
            scene partner.
          </p>
          {!clientSecret && (
            <p className="plan-price" aria-label="Seven dollars per month">
              <strong>$7</strong>
              <span>/month</span>
            </p>
          )}

          <ul>
            {features.map((feature) => (
              <li key={feature}>
                <span aria-hidden="true">✓</span>
                {feature}
              </li>
            ))}
          </ul>
          {isSubscribed ? (
            <button type="button" onClick={() => navigate("/billing")}>
              Manage subscription <span>→</span>
            </button>
          ) : !user ? (
            <button type="button" onClick={() => navigate("/signup")}>
              Try 3 rehearsals for Free <span>→</span>
            </button>
          ) : clientSecret ? (
            <StripeElementsForm
              clientSecret={clientSecret}
              submitLabel="Subscribe"
              showTotal
              onCancel={() => setClientSecret(null)}
              onConfirmed={() => {
                setClientSecret(null);
                setConfirming(true);
              }}
            />
          ) : (
            <>
              <button onClick={startSubscription} disabled={busy || confirming}>
                {confirming ? (
                  "Confirming your subscription…"
                ) : busy ? (
                  "Starting…"
                ) : sessionsExhausted ? (
                  <>
                    Subscribe to keep rehearsing <span>→</span>
                  </>
                ) : (
                  <>
                    Subscribe — $7/month <span>→</span>
                  </>
                )}
              </button>
              {freeSessionsRemaining > 0 && (
                <button
                  type="button"
                  className="plan-free-link"
                  onClick={() => navigate("/#upload")}
                  disabled={busy}
                >
                  You still have {freeSessionsRemaining} free session
                  {freeSessionsRemaining === 1 ? "" : "s"} — rehearse free{" "}
                  <span>→</span>
                </button>
              )}
            </>
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
