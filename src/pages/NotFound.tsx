import { Link } from "react-router-dom";
import Seo from "../components/Seo";
import SiteNav from "../components/SiteNav";
import { useAuth } from "../contexts/AuthContext";

/** Any path no route claims: say so, and offer the ways back. */
export default function NotFound() {
  const { user } = useAuth();
  return (
    <main className="cinematic-page auth-page">
      <Seo
        title="Page Not Found"
        description="This page doesn't exist."
        path="/404"
        noindex
      />
      <div className="cinematic-backdrop" aria-hidden="true" />
      <SiteNav />
      <section className="auth-layout">
        <div className="auth-card not-found-card">
          <header>
            <p>Error 404</p>
            <h1>This scene isn’t in the script.</h1>
          </header>
          <p className="not-found-copy">
            The page you’re looking for doesn’t exist or has moved.
          </p>
          <div className="auth-success-actions">
            <Link to="/" className="btn-primary-link">
              Go to the home page
            </Link>
            {user ? (
              <Link to="/account" className="auth-secondary-button auth-link-button">
                My Auditions
              </Link>
            ) : (
              <Link to="/faq" className="auth-secondary-button auth-link-button">
                Read the FAQ
              </Link>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
