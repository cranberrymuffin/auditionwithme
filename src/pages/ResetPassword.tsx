import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import Seo from "../components/Seo";
import SiteNav from "../components/SiteNav";
import SiteFooter from "../components/SiteFooter";
import AuthAside from "../components/marketing/AuthAside";
import PasswordField from "../components/PasswordField";
import { supabase } from "../lib/supabase";
import { authRedirectOrigin } from "../lib/platform";
import { friendlyAuthError } from "../lib/authErrors";
import { useToast } from "../lib/toast";
import { PASSWORD_HINT, PASSWORD_MIN_LENGTH } from "../lib/passwordRules";

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
      redirectTo: `${authRedirectOrigin()}/reset-password`,
    });
    setSubmitting(false);
    if (resetError) {
      setError(friendlyAuthError(resetError, "reset"));
      return;
    }
    setSent(true);
  }

  return (
    <main className="page auth-page">
      <Seo
        title="Reset Password"
        description="Reset your AuditionWithMe password."
        path="/forgot-password"
        noindex
      />
      <SiteNav />
      <section className="wrap grid auth-layout">
        <form className="form auth-form span-5" onSubmit={handleSubmit}>
          {sent ? (
            <div className="auth-success" role="status">
              <h1 className="title">Check your email.</h1>
              <p>
                If an account exists for{" "}
                <span className="auth-email">{email}</span>, a link to reset
                your password is on its way. It can take a minute — check
                spam too.
              </p>
              <div className="auth-success-actions">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setSent(false)}
                >
                  Use a different email
                </button>
                <Link to="/login" className="btn-primary">
                  Back to log in
                </Link>
              </div>
            </div>
          ) : (
            <>
              <header className="auth-head">
                <p className="slug">Forgot your password?</p>
                <h1 className="title">Reset it</h1>
              </header>
              <label className="field-label" htmlFor="reset-email">
                Email
              </label>
              <input
                id="reset-email"
                className="input"
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
              <button type="submit" className="btn-primary btn-lg auth-submit" disabled={submitting}>
                {submitting ? "Sending…" : "Email me a reset link"}
              </button>
              <p className="auth-alt">
                Remembered it?{" "}
                <Link className="link" to="/login">
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
    <main className="page auth-page">
      <Seo
        title="Set a New Password"
        description="Choose a new AuditionWithMe password."
        path="/reset-password"
        noindex
      />
      <SiteNav />
      <section className="wrap grid auth-layout">
        <form className="form auth-form span-5" onSubmit={handleSubmit}>
          {hasSession === false ? (
            <div className="auth-success" role="status">
              <h1 className="title">That link has expired.</h1>
              <p>Reset links work once and only for a short time. Request a new one and use it right away.</p>
              <div className="auth-success-actions">
                <Link to="/forgot-password" className="btn-primary">
                  Send a new link
                </Link>
              </div>
            </div>
          ) : (
            <>
              <header className="auth-head">
                <p className="slug">Almost there</p>
                <h1 className="title">Set a new password</h1>
              </header>
              <PasswordField
                id="new-password"
                label="New password"
                value={password}
                autoComplete="new-password"
                minLength={PASSWORD_MIN_LENGTH}
                hint={PASSWORD_HINT}
                onChange={setPassword}
              />
              {error && (
                <p className="auth-error" role="alert">
                  {error}
                </p>
              )}
              <button
                type="submit"
                className="btn-primary btn-lg auth-submit"
                disabled={submitting || hasSession === null}
              >
                {submitting ? "Saving…" : "Save new password"}
              </button>
            </>
          )}
        </form>
        <AuthAside />
      </section>
      <SiteFooter />
    </main>
  );
}
