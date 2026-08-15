import { useEffect, useRef, useState } from "react";
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
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);

  const isSubscriber = !!user && entitlement?.subscription_status === "active";
  const subscriptionLabel = isSubscriber ? "Manage subscription" : "Pricing";

  // Logged-in users get pricing/subscription access via the "My account"
  // dropdown instead of a top-level nav link.
  const showPricing = !loading && !user;

  // Close the mobile menu and account dropdown on any route change.
  useEffect(() => {
    setMenuOpen(false);
    setAccountMenuOpen(false);
  }, [location.pathname, location.hash]);

  // Close the account dropdown on outside click.
  useEffect(() => {
    if (!accountMenuOpen) return;
    function handleClick(event: MouseEvent) {
      if (
        accountMenuRef.current &&
        !accountMenuRef.current.contains(event.target as Node)
      ) {
        setAccountMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [accountMenuOpen]);

  async function handleLogout() {
    setMenuOpen(false);
    setAccountMenuOpen(false);
    await supabase.auth.signOut();
    navigate("/");
  }

  const closeMenu = () => setMenuOpen(false);

  const sharedLinks = (
    <>
      {!loading && !user && (
        <a
          className="eyebrow site-nav-link"
          href="/about#how-it-works"
          onClick={closeMenu}
        >
          How it works
        </a>
      )}
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

  const isAccountAreaActive =
    location.pathname === "/account" || location.pathname === "/pricing";

  const accountDropdown = (
    <div className="site-nav-account" ref={accountMenuRef}>
      <button
        type="button"
        className={`eyebrow site-nav-link site-nav-account-trigger ${
          isAccountAreaActive ? "is-active" : ""
        }`}
        aria-haspopup="menu"
        aria-expanded={accountMenuOpen}
        onClick={() => setAccountMenuOpen((open) => !open)}
      >
        My account
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="site-nav-account-caret"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {accountMenuOpen && (
        <div className="site-nav-account-menu" role="menu">
          <NavLink
            to="/pricing"
            role="menuitem"
            className={({ isActive }) =>
              `site-nav-account-menu-item ${isActive ? "is-active" : ""}`
            }
            onClick={() => setAccountMenuOpen(false)}
          >
            {subscriptionLabel}
          </NavLink>
          <NavLink
            to="/account"
            role="menuitem"
            className={({ isActive }) =>
              `site-nav-account-menu-item ${isActive ? "is-active" : ""}`
            }
            onClick={() => setAccountMenuOpen(false)}
          >
            My scripts
          </NavLink>
        </div>
      )}
    </div>
  );

  const authLinks = loading ? null : user ? (
    <>
      {accountDropdown}
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
              <span className="site-nav-drawer-heading">My account</span>
              <NavLink
                to="/pricing"
                className={({ isActive }) =>
                  `${navLinkClass({ isActive })} site-nav-drawer-sublink`
                }
                onClick={closeMenu}
              >
                {subscriptionLabel}
              </NavLink>
              <NavLink
                to="/account"
                className={({ isActive }) =>
                  `${navLinkClass({ isActive })} site-nav-drawer-sublink`
                }
                onClick={closeMenu}
              >
                My scripts
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
