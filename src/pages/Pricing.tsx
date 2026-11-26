import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import Modal from "../components/Modal";
import Seo from "../components/Seo";
import SiteNav from "../components/SiteNav";
import SiteFooter from "../components/SiteFooter";
import ConsentCheckbox from "../components/ConsentCheckbox";
import ExternalLink from "../components/ExternalLink";
import { apiFetch } from "../lib/api";
import { useAuth } from "../contexts/AuthContext";
import { useEntitlement } from "../hooks/useEntitlement";
import { usePlan } from "../hooks/usePlan";
import { TRIAL_DAYS, formatPlanPrice, hasPlanAccess } from "../lib/plan";
import { TERMS_VERSION } from "../lib/termsText";

// Stripe loads with the checkout modal, not with the page: this page is
// part of the marketing bundle (and prerendered), the card form isn't.
const StripeElementsForm = lazy(() => import("../components/billing/StripeElementsForm"));

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
  // The build-time prerender would bake in the build day's date, which goes
  // stale in search snippets; crawlers get a relative label instead.
  if (typeof document === "undefined") return `Day ${days}`;
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
  const [agreeTerms, setAgreeTerms] = useState(false);
  // Set when the server says the Terms are missing even though the cached
  // entitlement said otherwise, so the checkbox appears.
  const [termsRequired, setTermsRequired] = useState(false);

  const isSubscribed = hasPlanAccess(entitlement?.subscription_status);
  // Accounts that signed up before the Terms existed (beta, which agreed to
  // the NDA instead) accept them here, at their first purchase; everyone else
  // accepted them at signup. The server enforces this (api/billing.ts
  // create-subscription).
  const needsTerms =
    Boolean(user) && (termsRequired || entitlement?.terms_version !== TERMS_VERSION);
  // The trial is for a first subscription only, and only the server knows
  // for sure (api/billing.ts: a past subscription under this customer, or
  // this email's trial already used on another account). Its answer decides
  // the offer; the cached subscription ID only stands in if it can't be had.
  const [serverTrialEligible, setServerTrialEligible] = useState<boolean | null>(null);
  const [trialCheckDone, setTrialCheckDone] = useState(false);
  const userId = user?.id;
  useEffect(() => {
    if (!userId) return;
    let active = true;
    apiFetch("/api/billing")
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as { trialEligible?: unknown } | null;
        if (active && response.ok && typeof payload?.trialEligible === "boolean") {
          setServerTrialEligible(payload.trialEligible);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (active) setTrialCheckDone(true);
      });
    return () => {
      active = false;
    };
  }, [userId]);
  const trialEligible = serverTrialEligible ?? !entitlement?.stripe_subscription_id;
  // Signed in and not yet answered: don't promise (or start) either offer.
  const checkingTrial = Boolean(user) && !isSubscribed && !trialCheckDone;
  // The server found a subscription this page didn't know about (409).
  const [alreadySubscribed, setAlreadySubscribed] = useState(false);
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
    if (!consentGiven) return;
    setBusy(true);
    setError(null);
    setAlreadySubscribed(false);
    try {
      const response = await apiFetch(
        "/api/billing?action=create-subscription",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...(needsTerms ? { termsVersion: TERMS_VERSION } : {}),
          }),
        },
      );
      const payload = await response.json().catch(() => null);
      if (response.status === 403 && payload?.reason === "terms_required") {
        setTermsRequired(true);
        setError(payload.error);
        return;
      }
      if (response.status === 409) {
        setAlreadySubscribed(true);
        // The cached plan may just be behind: look again.
        refreshRef.current();
        return;
      }
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
  const consentGiven = !needsTerms || agreeTerms;
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
    <main className="page pricing-page">
      <Seo
        title="Pricing"
        description={`Try Audition Plus free for ${trialDays} days — unlimited rehearsals with AI scene partners. Cancel anytime.`}
        path="/pricing"
      />
      <SiteNav />

      <section className="wrap grid pricing-main">
        <div className="pricing-intro span-6">
          <p className="slug">{intro.eyebrow}</p>
          <h1 className="title">{intro.title}</h1>
          <p className="lead">{intro.sub}</p>

          {offerTrial && !confirming && (
            <ol className="trial-timeline" aria-label="How the free trial works">
              <li>
                <strong>Today</strong>
                <p>Full access starts the moment you add a card.</p>
              </li>
              <li>
                <strong>Anytime before {trialEndLabel}</strong>
                <p>Cancel from Billing in two clicks — you won't be charged.</p>
              </li>
              <li>
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
                className="btn-primary"
                onClick={() => navigate("/#upload")}
              >
                Upload a script <span className="btn-arrow" aria-hidden="true">→</span>
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => navigate("/billing")}
              >
                Manage billing
              </button>
            </div>
          )}
        </div>

        <article
          className={`pricing-plan span-5 at-8 ${isSubscribed ? "is-current" : ""}`}
          aria-labelledby="plan-name"
        >
          <header>
            <div>
              <p id="plan-name">Audition Plus</p>
              <span>For actors with auditions on the calendar</span>
            </div>
            {isSubscribed ? (
              <span className="tag tag-success">Current plan</span>
            ) : (
              offerTrial && (
                <span className="tag tag-accent">{trialDays} days free</span>
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
              <li key={feature}>{feature}</li>
            ))}
          </ul>

          {isSubscribed ? (
            <button
              type="button"
              className="btn-primary btn-lg btn-block"
              onClick={() => navigate("/billing")}
            >
              Manage subscription <span className="btn-arrow" aria-hidden="true">→</span>
            </button>
          ) : (
            <>
              {needsTerms && !confirming && (
                <div className="pricing-consent">
                  <ConsentCheckbox checked={agreeTerms} onChange={setAgreeTerms}>
                    I agree to the{" "}
                    <ExternalLink href="/terms">Terms and Conditions</ExternalLink>
                    .
                  </ConsentCheckbox>
                </div>
              )}
              <button
                type="button"
                className="btn-primary btn-lg btn-block"
                onClick={startSubscription}
                disabled={
                  busy ||
                  confirming ||
                  checkingTrial ||
                  !consentGiven
                }
              >
                {checkingTrial ? (
                  <>
                    <span className="billing-spinner" aria-hidden="true" />
                    Checking your plan…
                  </>
                ) : confirming ? (
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
                    {ctaLabel} <span className="btn-arrow" aria-hidden="true">→</span>
                  </>
                )}
              </button>
            </>
          )}

          {!isSubscribed && (
            <p className="pricing-fineprint">
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
          {alreadySubscribed && (
            <p className="plan-error" role="alert">
              You already have a subscription. Manage it from{" "}
              <Link to="/billing">Billing</Link>.
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
          <Suspense fallback={null}>
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
          </Suspense>
          <p className="checkout-secure-note">
            Payments are processed securely by Stripe. Audition With Me never
            sees your card number.
          </p>
        </Modal>
      )}

      <section className="section" aria-labelledby="pricing-questions">
        <div className="wrap grid">
          <header className="section-head span-4">
            <p className="slug">Before you begin</p>
            <h2 id="pricing-questions" className="title">
              Plan details
            </h2>
          </header>
          <div className="qa span-7 at-6">
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
                "Your scripts and self-tapes are saved only on your device, never in our database. To run a rehearsal, your script’s text is sent to Anthropic and ElevenLabs, and your microphone audio to ElevenLabs, to be processed. The FAQ has the details.",
              ],
            ].map(([question, answer], index) => (
              <details key={question} open={index === 0}>
                <summary>
                  {question}
                  <span className="qa-icon" aria-hidden="true" />
                </summary>
                <p>{answer}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
