import ScriptName from "../ScriptName";
import { STEP_NAMES } from "./stepNames";

/**
 * The row atop each practice setup step, set like a script page's running
 * header: which step this is on the left, the script's name on the right
 * (read-only here; it's renamed from step 1's heading).
 */
export default function StepHeader({
  step,
  scriptName,
}: {
  step: number;
  scriptName: string;
}) {
  return (
    <div className="step-header slug">
      <p className="step-header-label">
        Step {step} of {STEP_NAMES.length}
        <span className="sr-only"> · {STEP_NAMES[step - 1]}</span>
      </p>
      <div className="step-header-script" title={scriptName}>
        <ScriptName name={scriptName} />
      </div>
    </div>
  );
}
