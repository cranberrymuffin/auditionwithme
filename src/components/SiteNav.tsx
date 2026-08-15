import { Link, NavLink, useNavigate } from "react-router-dom";
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

export default function SiteNav() {
  const { user, loading } = useAuth();
  const { entitlement } = useEntitlement();
  const navigate = useNavigate();

  const showPricing =
    !loading && (!user || entitlement?.subscription_status !== "active");

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
        {showPricing && (
          <NavLink
            to="/pricing"
            className={({ isActive }) =>
              `eyebrow site-nav-link ${isActive ? "is-active" : ""}`
            }
          >
            Pricing
          </NavLink>
        )}
        {!loading && !user && (
          <NavLink
            to="/about"
            className={({ isActive }) =>
              `eyebrow site-nav-link ${isActive ? "is-active" : ""}`
            }
          >
            About
          </NavLink>
        )}
        {!loading &&
          (user ? (
            <>
              <NavLink
                to="/account"
                className={({ isActive }) =>
                  `eyebrow site-nav-link ${isActive ? "is-active" : ""}`
                }
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
            <NavLink
              to="/signup"
              className={({ isActive }) =>
                `eyebrow site-nav-link ${isActive ? "is-active" : ""}`
              }
            >
              Sign up
            </NavLink>
          ))}
      </div>
    </nav>
  );
}
