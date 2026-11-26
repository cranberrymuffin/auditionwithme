import { Link } from "react-router-dom";
import { IS_BETA_TESTING } from "../lib/beta";

/** The foot of every public page: what this is, the pages a visitor might
 * still want, and how to reach a person. */
export default function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="wrap site-footer-inner">
        <div className="site-footer-brand">
          <strong>Audition With Me</strong>
          <p>A rehearsal partner and self-tape recorder for actors.</p>
        </div>
        <ul className="site-footer-links">
          <li>
            <Link to="/how-it-works">How it works</Link>
          </li>
          <li>
            <Link to="/faq">FAQ</Link>
          </li>
          {!IS_BETA_TESTING && (
            <li>
              <Link to="/pricing">Pricing</Link>
            </li>
          )}
          <li>
            <Link to="/terms">Terms</Link>
          </li>
        </ul>
        <p className="site-footer-note">
          Questions? Write to{" "}
          <a className="link" href="mailto:team@auditionwithme.com">
            team@auditionwithme.com
          </a>
        </p>
      </div>
    </footer>
  );
}
