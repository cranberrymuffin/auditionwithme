import { Link } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { IS_BETA_TESTING } from "../../lib/beta";
import { TRIAL_DAYS } from "../../lib/plan";

/** The way into the product from a marketing page: sign up, or for someone
 * already signed in, back to the upload on the home page. States the offer
 * this build actually makes (beta, or trial then subscription). */
export default function StartCta() {
  const { user } = useAuth();
  return (
    <div className="start-cta">
      {user ? (
        <Link to="/" className="btn-primary btn-lg">
          Upload your script <span className="btn-arrow" aria-hidden="true">→</span>
        </Link>
      ) : (
        <>
          <Link to="/signup" className="btn-primary btn-lg">
            Start rehearsing free <span className="btn-arrow" aria-hidden="true">→</span>
          </Link>
          <p className="meta">
            {IS_BETA_TESTING
              ? "Free during beta"
              : `${TRIAL_DAYS}-day free trial · Cancel anytime`}
          </p>
        </>
      )}
    </div>
  );
}
