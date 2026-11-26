import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import Seo from "../components/Seo";
import SiteNav from "../components/SiteNav";
import SiteFooter from "../components/SiteFooter";
import AuthAside from "../components/marketing/AuthAside";
import ConsentCheckbox from "../components/ConsentCheckbox";
import ExternalLink from "../components/ExternalLink";
import PasswordField from "../components/PasswordField";
import { friendlyAuthError } from "../lib/authErrors";
import { IS_BETA_TESTING } from "../lib/beta";
import { TRIAL_DAYS } from "../lib/plan";
import { TERMS_VERSION } from "../lib/termsText";
import { supabase } from "../lib/supabase";
import { authRedirectOrigin } from "../lib/platform";
import { PASSWORD_HINT, PASSWORD_MIN_LENGTH } from "../lib/passwordRules";
import { rememberSignupIntent, type AuthRedirect } from "../lib/signupIntent";

export default function Signup() {
  // Carries the visitor's original destination/intent (e.g. the home upload
  // flow) through to login so their action resumes after authenticating.
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [accountCreated, setAccountCreated] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  const consentRef = useRef<HTMLInputElement>(null);
  // Resend on the "check your email" screen, rate-limited client-side to
  // match Supabase's own per-address cooldown.
  const [resendIn, setResendIn] = useState(0);
  const [resendNotice, setResendNotice] = useState<string | null>(null);

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setTimeout(() => setResendIn((seconds) => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  async function resendConfirmation() {
    setResendNotice(null);
    setError(null);
    const { error: resendError } = await supabase.auth.resend({
      type: "signup",
      email,
      options: { emailRedirectTo: `${authRedirectOrigin()}/login` },
    });
    if (resendError) {
      setError(friendlyAuthError(resendError, "sign up"));
      return;
    }
    setResendNotice("Sent again. Check your inbox and spam folder.");
    setResendIn(60);
  }

  // The required checkbox above the button is the agreement -- the NDA in
  // beta, the Terms after -- so agreeing and creating the account are one
  // step. Auto-renewal consent waits until checkout (Pricing.tsx).
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!agreed) {
      setConsentError(
        `Tick the box to agree to the ${IS_BETA_TESTING ? "Beta Tester NDA" : "Terms and Conditions"} before signing up.`,
      );
      consentRef.current?.focus();
      return;
    }
    setSubmitting(true);
    setError(null);

    const { data, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${authRedirectOrigin()}/login`,
        // Read by the handle_new_user trigger (see
        // supabase/migrations/20261101120000_terms_acceptance.sql) and
        // written straight to entitlements -- there's no session yet at this
        // point (email confirmation is pending) for a client-side write.
        data: IS_BETA_TESTING
          ? { nda_accepted_at: new Date().toISOString() }
          : {
              terms_version: TERMS_VERSION,
              terms_accepted_at: new Date().toISOString(),
            },
      },
    });

    setSubmitting(false);

    if (signUpError) {
      setError(friendlyAuthError(signUpError, "sign up"));
      return;
    }

    // Supabase doesn't return an error for a duplicate signup when email
    // confirmation is on -- returning one would let an attacker enumerate
    // registered emails. Instead an existing, already-confirmed account
    // comes back with an empty identities array, which is the documented
    // way to detect it client-side.
    if (data.user && data.user.identities?.length === 0) {
      setError("An account with this email already exists. Log in instead.");
      return;
    }

    // The confirmation link signs them in on /login, which picks this up
    // and carries on to where they were going (Login.tsx).
    rememberSignupIntent(location.state as AuthRedirect);
    setAccountCreated(true);
    setResendIn(60);
  }

  return (
    <main className="page auth-page">
      <Seo
        title="Sign Up"
        description={
          IS_BETA_TESTING
            ? "Create a free AuditionWithMe account and start rehearsing your scripts today. Free during beta."
            : `Create an AuditionWithMe account and rehearse your scripts free for ${TRIAL_DAYS} days.`
        }
        path="/signup"
      />
      <SiteNav />

      <section className="wrap grid auth-layout">
        <form className="form auth-form span-5" onSubmit={handleSubmit}>
          {accountCreated ? (
            <div className="auth-success" role="status">
              <h1 className="title">Check your email to confirm your account.</h1>
              <p>
                We sent a confirmation link to{" "}
                <span className="auth-email">{email}</span>. Open it on this
                device and you’ll be signed in and taken straight back to
                where you left off.
              </p>
              <div className="auth-success-actions">
                <Link to="/login" state={location.state} className="btn-primary">
                  I’ve confirmed — log in
                </Link>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={resendIn > 0}
                  onClick={() => void resendConfirmation()}
                >
                  {resendIn > 0 ? `Resend email (${resendIn}s)` : "Resend email"}
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    setAccountCreated(false);
                    setResendNotice(null);
                    setError(null);
                  }}
                >
                  Use a different email
                </button>
              </div>
              {resendNotice && <p className="auth-notice">{resendNotice}</p>}
            </div>
          ) : (
            <>
              <header className="auth-head">
                {IS_BETA_TESTING && <p className="slug">Free during beta</p>}
                <h1 className="title">Create your account</h1>
              </header>
              <label className="field-label" htmlFor="signup-email">
                Email
              </label>
              <input
                id="signup-email"
                className="input"
                type="email"
                value={email}
                autoComplete="email"
                required
                onChange={(event) => setEmail(event.target.value)}
              />

              <PasswordField
                id="signup-password"
                label="Password"
                value={password}
                autoComplete="new-password"
                minLength={PASSWORD_MIN_LENGTH}
                hint={PASSWORD_HINT}
                onChange={setPassword}
              />

              <aside className="notice notice-accent signup-data-note" aria-labelledby="signup-data-note-title">
                <strong id="signup-data-note-title">What happens to your script</strong>
                <p>
                  Your scripts and self-tapes are saved only on your device,
                  never in our database. To run a rehearsal, your script’s
                  text is sent to Anthropic and ElevenLabs, and your
                  microphone audio to ElevenLabs, to be processed.{" "}
                  <ExternalLink href="/faq#your-script">Read the details</ExternalLink>
                </p>
              </aside>

              <ConsentCheckbox
                checked={agreed}
                onChange={(checked) => {
                  setAgreed(checked);
                  if (checked) setConsentError(null);
                }}
                error={consentError}
                inputRef={consentRef}
              >
                I agree to the{" "}
                {IS_BETA_TESTING ? (
                  <ExternalLink href="/nda">Beta Tester NDA</ExternalLink>
                ) : (
                  <ExternalLink href="/terms">Terms and Conditions</ExternalLink>
                )}
                .
              </ConsentCheckbox>
            </>
          )}

          {error && (
            <p className="auth-error" role="alert">
              {error}
            </p>
          )}

          {!accountCreated && (
            <>
              <button type="submit" className="btn-primary btn-lg auth-submit" disabled={submitting}>
                {submitting ? "Creating account…" : "Sign up"}
              </button>

              <p className="auth-alt">
                Already have an account?{" "}
                <Link className="link" to="/login" state={location.state}>
                  Log in
                </Link>
              </p>
            </>
          )}
        </form>
        <AuthAside />
      </section>
      <SiteFooter />
    </main>
  );
}
