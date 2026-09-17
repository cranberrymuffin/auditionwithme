import { useState, type FormEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import Seo from "../components/Seo";
import SiteNav from "../components/SiteNav";
import NdaModal from "../components/NdaModal";
import { IS_BETA_TESTING } from "../lib/beta";
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
      setError(signUpError.message);
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
  }

  return (
    <main className="cinematic-page auth-page">
      <Seo
        title="Sign Up"
        description={
          IS_BETA_TESTING
            ? "Create a free AuditionWithMe account and start rehearsing your scripts today. Free during beta."
            : "Create a free AuditionWithMe account and start rehearsing your scripts today. 3 free sessions, no credit card required."
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
                We sent a confirmation link to {email}. Click it, then{" "}
                <Link to="/login" state={location.state}>
                  log in
                </Link>{" "}
                to continue.
              </p>
            </div>
          ) : (
            <>
              <header>
                <p>{IS_BETA_TESTING ? "Beta test now" : "Three free sessions"}</p>
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

              <label htmlFor="signup-password">Password</label>
              <input
                id="signup-password"
                type="password"
                value={password}
                autoComplete="new-password"
                minLength={6}
                required
                onChange={(event) => setPassword(event.target.value)}
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
