import { useEffect, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { useEntitlement } from "../hooks/useEntitlement";
import { supabase } from "../lib/supabase";

export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-baseline gap-1.5 text-hero-ink ${className}`}
    >
      <span className="display-title text-[1.05rem] tracking-[0.08em]">
        Audition
      </span>
      <span className="script-accent text-[1.3rem] leading-none text-coral-500">
        with me
      </span>
    </span>
  );
}

function navLinkClass({ isActive }: { isActive: boolean }) {
  return `eyebrow site-nav-link ${isActive ? "is-active" : ""}`;
}

export default function SiteNav() {
  const { user, loading } = useAuth();
  const { entitlement } = useEntitlement();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  const showPricing =
    !loading && (!user || entitlement?.subscription_status !== "active");

  // Close the mobile menu on any route change.
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname, location.hash]);

  async function handleLogout() {
    setMenuOpen(false);
    await supabase.auth.signOut();
    navigate("/");
  }

  const closeMenu = () => setMenuOpen(false);

  const sharedLinks = (
    <>
      <a
        className="eyebrow site-nav-link"
        href="/about#how-it-works"
        onClick={closeMenu}
      >
        How it works
      </a>
      {showPricing && (
        <NavLink to="/pricing" className={navLinkClass} onClick={closeMenu}>
          Pricing
        </NavLink>
      )}
      {!loading && !user && (
        <NavLink to="/about" end className={navLinkClass} onClick={closeMenu}>
          About
        </NavLink>
      )}
    </>
  );

  const authLinks = loading ? null : user ? (
    <>
      <NavLink to="/account" className={navLinkClass} onClick={closeMenu}>
        My account
      </NavLink>
      <button
        type="button"
        className="eyebrow site-nav-link"
        onClick={handleLogout}
      >
        Log out
      </button>
    </>
  ) : (
    <>
      <NavLink to="/login" className={navLinkClass} onClick={closeMenu}>
        Log in
      </NavLink>
      <Link to="/signup" className="site-nav-cta" onClick={closeMenu}>
        Start free
      </Link>
    </>
  );

  return (
    <nav className="site-nav">
      <Link to="/" aria-label="AuditionWithMe home">
        <Wordmark />
      </Link>

      <div className="site-nav-links">
        {sharedLinks}
        {authLinks}
      </div>

      <div className="site-nav-mobile">
        {!loading && !user && (
          <Link to="/signup" className="site-nav-cta" onClick={closeMenu}>
            Start free
          </Link>
        )}
        <button
          type="button"
          className="site-nav-menu"
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            {menuOpen ? (
              <path d="M5 5l14 14M19 5L5 19" />
            ) : (
              <path d="M4 7h16M4 12h16M4 17h16" />
            )}
          </svg>
        </button>
      </div>

      {menuOpen && (
        <div className="site-nav-drawer">
          {sharedLinks}
          {loading ? null : user ? (
            <>
              <NavLink
                to="/account"
                className={navLinkClass}
                onClick={closeMenu}
              >
                My account
              </NavLink>
              <button
                type="button"
                className="eyebrow site-nav-link"
                onClick={handleLogout}
              >
                Log out
              </button>
            </>
          ) : (
            <>
              <NavLink to="/login" className={navLinkClass} onClick={closeMenu}>
                Log in
              </NavLink>
              <Link to="/signup" className="site-nav-cta" onClick={closeMenu}>
                Start free
              </Link>
            </>
          )}
        </div>
      )}
    </nav>
  );
}
