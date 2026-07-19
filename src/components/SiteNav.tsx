import { Link, NavLink } from "react-router-dom";

export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-baseline gap-1.5 text-hero-ink ${className}`}>
      <span className="display-title text-[1.05rem] tracking-[0.08em]">Audition</span>
      <span className="script-accent text-[1.3rem] leading-none text-coral-500">with me</span>
    </span>
  );
}

export default function SiteNav() {
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
        <Link to="/" className="site-nav-cta">Start rehearsing</Link>
      </div>
    </nav>
  );
}
