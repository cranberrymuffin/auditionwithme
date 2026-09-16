import { useState, type FormEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import Seo from "../components/Seo";
import SiteNav from "../components/SiteNav";
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

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setAccountCreated(false);
    setSubmitting(true);

    const { error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${window.location.origin}/login` },
    });

    if (signUpError) {
      setSubmitting(false);
      setError(signUpError.message);
      return;
    }

    setSubmitting(false);
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
                {submitting ? "Creating account…" : "Sign up"}{" "}
                <span aria-hidden="true">→</span>
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
    </main>
  );
}
