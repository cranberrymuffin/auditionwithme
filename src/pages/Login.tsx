import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import Seo from "../components/Seo";
import SiteNav from "../components/SiteNav";
import PasswordField from "../components/PasswordField";
import { supabase } from "../lib/supabase";
import { friendlyAuthError } from "../lib/authErrors";
import { clearAuthLink, hasAuthLink, readAuthLink } from "../lib/authLink";

type RedirectState = { from?: { pathname?: string }; intent?: string } | null;

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Signup confirmation links land here. In the browser that signed up,
  // supabase-js has already traded the link's code for a session by the
  // time getSession() resolves; anywhere else the email is confirmed but
  // nobody is signed in, so the visitor just logs in.
  useEffect(() => {
    const link = readAuthLink(window.location.href);
    if (!hasAuthLink(link)) return;
    let active = true;
    void supabase.auth.getSession().then(({ data }) => {
      // Only now: supabase-js reads the code from the address bar.
      clearAuthLink();
      if (!active) return;
      if (link.code && data.session) {
        navigate("/", { replace: true });
      } else if (link.error) {
        setError(link.error);
      } else if (link.code) {
        setNotice("Your email is confirmed. Log in to continue.");
      }
    });
    return () => {
      active = false;
    };
  }, [navigate]);

  // RequireAuth forwards the page the user was originally headed to; the
  // home hero also passes an intent (e.g. "upload") so the visitor's original
  // action resumes after authentication.
  const redirectState = location.state as RedirectState;
  const destination = redirectState?.from?.pathname ?? "/";

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
      return;
    }
    navigate(destination, {
      replace: true,
      state: redirectState?.intent ? { intent: redirectState.intent } : null,
    });
  }

  return (
    <main className="cinematic-page auth-page">
      <Seo
        title="Log In"
        description="Log in to AuditionWithMe to continue rehearsing your saved scripts."
        path="/login"
      />
      <div className="cinematic-backdrop" aria-hidden="true" />
      <SiteNav />

      <section className="auth-layout">
        <form className="auth-card" onSubmit={handleSubmit}>
          <header>
            <p>Welcome back</p>
            <h1>Log in</h1>
            {notice && (
              <p className="auth-notice" role="status">
                {notice}
              </p>
            )}
          </header>

          <label htmlFor="login-email">Email</label>
          <input
            id="login-email"
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
            <Link to="/forgot-password" state={{ email }}>
              Forgot password?
            </Link>
          </p>

          {error && (
            <p className="auth-error" role="alert">
              {error}
            </p>
          )}

          <button type="submit" disabled={submitting}>
            {submitting ? "Logging in…" : "Log in"}{" "}
            <span aria-hidden="true">→</span>
          </button>

          <footer>
            New to Audition With Me?{" "}
            <Link to="/signup" state={redirectState}>
              Create an account
            </Link>
          </footer>
        </form>
      </section>
    </main>
  );
}
