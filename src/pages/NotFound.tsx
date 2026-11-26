import { Link } from "react-router-dom";
import Seo from "../components/Seo";
import SiteNav from "../components/SiteNav";
import SiteFooter from "../components/SiteFooter";
import { useAuth } from "../contexts/AuthContext";

/** Any path no route claims: say so, and offer the ways back. */
export default function NotFound() {
  const { user } = useAuth();
  return (
    <main className="page">
      <Seo
        title="Page Not Found"
        description="This page doesn't exist."
        path="/404"
        noindex
      />
      <SiteNav />
      <section className="wrap page-head not-found">
        <p className="slug">Error 404</p>
        <h1 className="title">This scene isn’t in the script.</h1>
        <p className="lead">
          The page you’re looking for doesn’t exist or has moved.
        </p>
        <div className="not-found-actions">
          <Link to="/" className="btn-primary">
            Go to the home page
          </Link>
          {user ? (
            <Link to="/account" className="btn-secondary">
              My Auditions
            </Link>
          ) : (
            <Link to="/faq" className="btn-secondary">
              Read the FAQ
            </Link>
          )}
        </div>
      </section>
      <SiteFooter />
    </main>
  );
}
