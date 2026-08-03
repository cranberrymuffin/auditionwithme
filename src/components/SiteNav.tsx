import { Link, NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { supabase } from "../lib/supabase";

export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-baseline gap-1.5 text-hero-ink ${className}`}>
      <span className="display-title text-[1.05rem] tracking-[0.08em]">Audition</span>
      <span className="script-accent text-[1.3rem] leading-none text-coral-500">with me</span>
    </span>
  );
}

export default function SiteNav() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await supabase.auth.signOut();
    navigate("/");
  }

  return (
    <nav className="site-nav">
      <Link to="/" aria-label="AuditionWithMe home">
        <Wordmark />
      </Link>
      <div className="site-nav-links">
        <NavLink to="/pricing" className={({ isActive }) => `eyebrow site-nav-link ${isActive ? "is-active" : ""}`}>
          Pricing
        </NavLink>
        <NavLink to="/about" className={({ isActive }) => `eyebrow site-nav-link ${isActive ? "is-active" : ""}`}>
          About
        </NavLink>
        {!loading && (user ? (
          <>
            <span className="eyebrow site-nav-user" title={user.email ?? ""}>{user.email}</span>
            <button type="button" className="eyebrow site-nav-link" onClick={handleLogout}>
              Log out
            </button>
          </>
        ) : (
          <>
            <NavLink to="/login" className={({ isActive }) => `eyebrow site-nav-link ${isActive ? "is-active" : ""}`}>
              Log in
            </NavLink>
            <NavLink to="/signup" className={({ isActive }) => `eyebrow site-nav-link ${isActive ? "is-active" : ""}`}>
              Sign up
            </NavLink>
          </>
        ))}
        <Link to="/#upload" className="site-nav-cta">Start rehearsing free</Link>
      </div>
    </nav>
  );
}
