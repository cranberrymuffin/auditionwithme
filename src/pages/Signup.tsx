import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import Seo from "../components/Seo";
import SiteNav from "../components/SiteNav";
import NdaModal from "../components/NdaModal";
import PasswordField from "../components/PasswordField";
import { friendlyAuthError } from "../lib/authErrors";
import { IS_BETA_TESTING } from "../lib/beta";
import { TRIAL_DAYS } from "../lib/plan";
import { supabase } from "../lib/supabase";

export default function Signup() {
  // Carries the visitor's original destination/intent (e.g. the home upload
  // flow) through to login so their action resumes after authenticating.
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [accountCreated, setAccountCreated] = useState(false);
  const [showNda, setShowNda] = useState(false);
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
      options: { emailRedirectTo: `${window.location.origin}/login` },
    });
    if (resendError) {
      setError(friendlyAuthError(resendError, "sign up"));
      return;
    }
    setResendNotice("Sent again. Check your inbox and spam folder.");
    setResendIn(60);
  }

  // The form itself just validates email/password and opens the NDA modal
  // -- account creation happens from there, in handleAcceptAndCreateAccount,
  // so agreeing to the NDA and creating the account are one step.
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setShowNda(true);
  }

  async function handleAcceptAndCreateAccount() {
    setSubmitting(true);
    setError(null);

    const { data, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/login`,
        // Read by the handle_new_user trigger (see
        // supabase/migrations/20260916120000_nda_acceptance.sql) and
        // written straight to entitlements.nda_accepted_at -- there's no
        // session yet at this point (email confirmation is pending) for a
        // client-side write gated by RLS.
        data: { nda_accepted_at: new Date().toISOString() },
      },
    });

    setSubmitting(false);
    setShowNda(false);

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

    setAccountCreated(true);
    setResendIn(60);
  }

  return (
    <main className="cinematic-page auth-page">
      <Seo
        title="Sign Up"
        description={
          IS_BETA_TESTING
            ? "Create a free AuditionWithMe account and start rehearsing your scripts today. Free during beta."
            : `Create an AuditionWithMe account and rehearse your scripts free for ${TRIAL_DAYS} days.`
        }
        path="/signup"
      />
      <div className="cinematic-backdrop" aria-hidden="true" />
      <SiteNav />

      <section className="auth-layout">
        <form className="auth-card" onSubmit={handleSubmit}>
          {accountCreated ? (
            <div className="auth-success" role="status">
              <h1>Check your email to confirm your account.</h1>
              <p>
                We sent a confirmation link to{" "}
                <span className="auth-email">{email}</span>. Click it, then{" "}
                <Link to="/login" state={location.state}>
                  log in
                </Link>{" "}
                to continue.
              </p>
              <div className="auth-success-actions">
                <Link to="/login" state={location.state} className="btn-primary-link">
                  Go to log in
                </Link>
                <button
                  type="button"
                  className="auth-secondary-button"
                  disabled={resendIn > 0}
                  onClick={() => void resendConfirmation()}
                >
                  {resendIn > 0 ? `Resend email (${resendIn}s)` : "Resend email"}
                </button>
                <button
                  type="button"
                  className="auth-secondary-button"
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
              <header>
                <p>{IS_BETA_TESTING ? "Free during beta" : `${TRIAL_DAYS}-day free trial`}</p>
                <h1>Create your account</h1>
              </header>
              <label htmlFor="signup-email">Email</label>
              <input
                id="signup-email"
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
                minLength={6}
                hint="At least 6 characters."
                onChange={setPassword}
              />
            </>
          )}

          {error && (
            <p className="auth-error" role="alert">
              {error}
            </p>
          )}

          {!accountCreated && (
            <>
              <button type="submit" disabled={submitting}>
                Sign up <span aria-hidden="true">→</span>
              </button>

              <footer>
                Already have an account?{" "}
                <Link to="/login" state={location.state}>
                  Log in
                </Link>
              </footer>
            </>
          )}
        </form>
      </section>

      {showNda && (
        <NdaModal
          submitting={submitting}
          onCancel={() => setShowNda(false)}
          onAccept={() => void handleAcceptAndCreateAccount()}
        />
      )}
    </main>
  );
}
