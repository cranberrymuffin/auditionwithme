import { Link } from "react-router-dom";

export default function SiteNav() {
  return (
    <nav className="site-nav">
      <Link to="/" className="site-nav__brand">AuditionWithMe</Link>
      <Link to="/pricing" className="site-nav__link">Pricing</Link>
      <Link to="/about" className="site-nav__link">About</Link>
    </nav>
  );
}
