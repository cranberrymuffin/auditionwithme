import ScriptName from "../ScriptName";
import { STEP_NAMES } from "./StepProgress";

/**
 * The row atop each practice setup step: which step this is on the left,
 * the script's name on the right (read-only here; it's renamed from step
 * 1's heading).
 */
export default function StepHeader({
  step,
  scriptName,
}: {
  step: number;
  scriptName: string;
}) {
  return (
    <div className="step-header">
      <p className="step-header-label">
        Step {step} of {STEP_NAMES.length} · {STEP_NAMES[step - 1]}
      </p>
      <div className="step-header-script" title={scriptName}>
        <ScriptName name={scriptName} />
      </div>
    </div>
  );
}
