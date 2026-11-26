import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import Seo from "../components/Seo";
import SiteNav from "../components/SiteNav";
import SiteFooter from "../components/SiteFooter";
import AuthAside from "../components/marketing/AuthAside";
import PasswordField from "../components/PasswordField";
import { supabase } from "../lib/supabase";
import { friendlyAuthError } from "../lib/authErrors";
import { useAuth } from "../contexts/AuthContext";
import { takeSignupIntent, type AuthRedirect } from "../lib/signupIntent";

/** A confirmation link that didn't work comes back with the reason in the
 * URL fragment (#error=access_denied&error_code=otp_expired…). */
function confirmationLinkProblem(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.hash.slice(1));
  if (!params.get("error") && !params.get("error_code")) return null;
  return "That confirmation link has expired or was already used. If you’ve confirmed already, log in below; otherwise sign up again to get a fresh link.";
}

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { user, loading } = useAuth();
  const [error, setError] = useState<string | null>(confirmationLinkProblem);
  const [submitting, setSubmitting] = useState(false);

  // RequireAuth forwards the page the user was originally headed to; the
  // home hero also passes an intent (e.g. "upload") so the visitor's original
  // action resumes after authentication.
  const redirectState = location.state as AuthRedirect;

  // Signed in, by this form or by an email confirmation link that landed
  // here with its session in the URL: carry on to where they were headed.
  // The link opens a fresh page with no router state, so that case reads
  // the destination Signup.tsx left behind.
  useEffect(() => {
    if (loading || !user) return;
    const target = redirectState ?? takeSignupIntent();
    navigate(target?.from?.pathname ?? "/", {
      replace: true,
      state: target?.intent ? { intent: target.intent } : null,
    });
  }, [loading, user, redirectState, navigate]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (signInError) {
      setSubmitting(false);
      setError(friendlyAuthError(signInError, "log in"));
    }
    // On success the effect above navigates, once the session lands.
  }

  return (
    <main className="page auth-page">
      <Seo
        title="Log In"
        description="Log in to AuditionWithMe to continue rehearsing your saved scripts."
        path="/login"
      />
      <SiteNav />

      <section className="wrap grid auth-layout" aria-busy={loading || Boolean(user)}>
        <form className="form auth-form span-5" onSubmit={handleSubmit}>
          <header className="auth-head">
            <p className="slug">Welcome back</p>
            <h1 className="title">Log in</h1>
          </header>

          <label className="field-label" htmlFor="login-email">
            Email
          </label>
          <input
            id="login-email"
            className="input"
            type="email"
            value={email}
            autoComplete="email"
            required
            onChange={(event) => setEmail(event.target.value)}
          />

          <PasswordField
            id="login-password"
            label="Password"
            value={password}
            autoComplete="current-password"
            onChange={setPassword}
          />
          <p className="auth-forgot">
            <Link className="link" to="/forgot-password" state={{ email }}>
              Forgot password?
            </Link>
          </p>

          {error && (
            <p className="auth-error" role="alert">
              {error}
            </p>
          )}

          <button type="submit" className="btn-primary btn-lg auth-submit" disabled={submitting}>
            {submitting ? "Logging in…" : "Log in"}
          </button>

          <p className="auth-alt">
            New to Audition With Me?{" "}
            <Link className="link" to="/signup" state={redirectState}>
              Create an account
            </Link>
          </p>
        </form>
        <AuthAside />
      </section>
      <SiteFooter />
    </main>
  );
}
