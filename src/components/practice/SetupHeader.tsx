import { Link } from "react-router-dom";
import { BrandMark } from "../SiteNav";
import StepProgress from "./StepProgress";

/** The header on every practice setup step: the brand, home, on the left;
 * the numbered steps (the way back to an earlier step) on the right. */
export default function SetupHeader({
  step,
  onGoToStep,
}: {
  /** 1-based. */
  step: number;
  onGoToStep?: (step: number) => void;
}) {
  return (
    <header className="setup-header">
      <div className="setup-header-inner">
        <Link to="/" className="site-nav-brand" aria-label="Audition With Me home">
          <BrandMark />
          <span className="brand-wordmark" aria-hidden="true">
            Audition With Me
          </span>
        </Link>
        <StepProgress current={step} onGoToStep={onGoToStep} />
      </div>
    </header>
  );
}
