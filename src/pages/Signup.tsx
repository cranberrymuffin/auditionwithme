import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import SiteNav from "../components/SiteNav";

export default function Signup() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmationSent, setConfirmationSent] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setConfirmationSent(false);
    setSubmitting(true);

    const response = await fetch("/api/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, secret }),
    });

    const payload = await response.json().catch(() => null);
    const signUpError = !response.ok ? payload?.error || "Could not create account." : null;

    if (signUpError) {
      setSubmitting(false);
      setError(signUpError);
      return;
    }

    setSubmitting(false);
    setConfirmationSent(true);
  }

  return (
    <main className="cinematic-page auth-page">
      <div className="cinematic-backdrop" aria-hidden="true" />
      <SiteNav />

      <section className="auth-layout">
        <form className="auth-card" onSubmit={handleSubmit}>
          <header>
            <p>Three free sessions</p>
            <h1>Create your account</h1>
          </header>

          {confirmationSent ? (
            <div className="auth-success" role="status">
              <p>Check your email to confirm your account.</p>
              <p>
                Once you confirm it, come back here and log in with your new
                credentials.
              </p>
            </div>
          ) : (
            <>
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

              <label htmlFor="signup-secret">Signup secret</label>
              <input
                id="signup-secret"
                type="password"
                value={secret}
                autoComplete="one-time-code"
                required
                onChange={(event) => setSecret(event.target.value)}
              />
            </>
          )}

          {error && (
            <p className="auth-error" role="alert">
              {error}
            </p>
          )}

          {!confirmationSent && (
            <button type="submit" disabled={submitting}>
              {submitting ? "Creating account…" : "Sign up"}{" "}
              <span aria-hidden="true">→</span>
            </button>
          )}

          <footer>
            {confirmationSent ? (
              <>
                Already confirmed? <Link to="/login">Log in</Link>
              </>
            ) : (
              <>
                Already have an account? <Link to="/login">Log in</Link>
              </>
            )}
          </footer>
        </form>
      </section>
    </main>
  );
}
