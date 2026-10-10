import { Link } from "react-router-dom";
import { BrandMark } from "../SiteNav";
import StepProgress from "./StepProgress";

/** The header on every practice setup step: the brand, home, on the left;
 * the step bars (the way back to an earlier step) in the middle. */
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
      <Link to="/" aria-label="Audition With Me home">
        <BrandMark />
      </Link>
      <StepProgress current={step} onGoToStep={onGoToStep} />
    </header>
  );
}
