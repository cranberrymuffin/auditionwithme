import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import Seo from "../components/Seo";
import SiteNav from "../components/SiteNav";
import PasswordField from "../components/PasswordField";
import { supabase } from "../lib/supabase";
import { friendlyAuthError } from "../lib/authErrors";
import { useToast } from "../lib/toast";

/** /forgot-password: ask for the email a reset link goes to. */
export function ForgotPassword() {
  const location = useLocation();
  const [email, setEmail] = useState(
    (location.state as { email?: string } | null)?.email ?? "",
  );
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setSubmitting(false);
    if (resetError) {
      setError(friendlyAuthError(resetError, "reset"));
      return;
    }
    setSent(true);
  }

  return (
    <main className="cinematic-page auth-page">
      <Seo
        title="Reset Password"
        description="Reset your AuditionWithMe password."
        path="/forgot-password"
        noindex
      />
      <div className="cinematic-backdrop" aria-hidden="true" />
      <SiteNav />
      <section className="auth-layout">
        <form className="auth-card" onSubmit={handleSubmit}>
          {sent ? (
            <div className="auth-success" role="status">
              <h1>Check your email.</h1>
              <p>
                If an account exists for{" "}
                <span className="auth-email">{email}</span>, a link to reset
                your password is on its way. It can take a minute — check
                spam too.
              </p>
              <div className="auth-success-actions">
                <button
                  type="button"
                  className="auth-secondary-button"
                  onClick={() => setSent(false)}
                >
                  Use a different email
                </button>
                <Link to="/login" className="btn-primary-link">
                  Back to log in
                </Link>
              </div>
            </div>
          ) : (
            <>
              <header>
                <p>Forgot your password?</p>
                <h1>Reset it</h1>
              </header>
              <label htmlFor="reset-email">Email</label>
              <input
                id="reset-email"
                type="email"
                value={email}
                autoComplete="email"
                required
                onChange={(event) => setEmail(event.target.value)}
              />
              {error && (
                <p className="auth-error" role="alert">
                  {error}
                </p>
              )}
              <button type="submit" disabled={submitting}>
                {submitting ? "Sending…" : "Email me a reset link"}
              </button>
              <footer>
                Remembered it? <Link to="/login">Log in</Link>
              </footer>
            </>
          )}
        </form>
      </section>
    </main>
  );
}

/** /reset-password: where the emailed link lands. Supabase signs the visitor
 * in with a recovery session from the link; this sets the new password. */
export default function ResetPassword() {
  const navigate = useNavigate();
  const toast = useToast();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // null while the link's session is still being read from the URL.
  const [hasSession, setHasSession] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      if (event === "PASSWORD_RECOVERY" || session) setHasSession(true);
    });
    // The link's tokens are parsed asynchronously; give that a moment
    // before deciding the link was bad.
    const timer = setTimeout(async () => {
      const { data } = await supabase.auth.getSession();
      if (active) setHasSession((current) => current ?? Boolean(data.session));
    }, 800);
    return () => {
      active = false;
      clearTimeout(timer);
      listener.subscription.unsubscribe();
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setSubmitting(false);
    if (updateError) {
      setError(friendlyAuthError(updateError, "update"));
      return;
    }
    toast("Your password is updated.", "success");
    navigate("/", { replace: true });
  }

  return (
    <main className="cinematic-page auth-page">
      <Seo
        title="Set a New Password"
        description="Choose a new AuditionWithMe password."
        path="/reset-password"
        noindex
      />
      <div className="cinematic-backdrop" aria-hidden="true" />
      <SiteNav />
      <section className="auth-layout">
        <form className="auth-card" onSubmit={handleSubmit}>
          {hasSession === false ? (
            <div className="auth-success" role="status">
              <h1>That link has expired.</h1>
              <p>Reset links work once and only for a short time. Request a new one and use it right away.</p>
              <div className="auth-success-actions">
                <Link to="/forgot-password" className="auth-secondary-button auth-link-button">
                  Send a new link
                </Link>
              </div>
            </div>
          ) : (
            <>
              <header>
                <p>Almost there</p>
                <h1>Set a new password</h1>
              </header>
              <PasswordField
                id="new-password"
                label="New password"
                value={password}
                autoComplete="new-password"
                minLength={6}
                hint="At least 6 characters."
                onChange={setPassword}
              />
              {error && (
                <p className="auth-error" role="alert">
                  {error}
                </p>
              )}
              <button type="submit" disabled={submitting || hasSession === null}>
                {submitting ? "Saving…" : "Save new password"}
              </button>
            </>
          )}
        </form>
      </section>
    </main>
  );
}
