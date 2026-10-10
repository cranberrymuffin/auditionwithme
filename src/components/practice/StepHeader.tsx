import ScriptName from "../ScriptName";

/**
 * The row atop each practice setup step: which step this is on the left,
 * the script's name on the right (read-only here; it's renamed from step
 * 1's heading).
 */
export default function StepHeader({
  step,
  title,
  scriptName,
}: {
  step: number;
  title: string;
  scriptName: string;
}) {
  return (
    <div className="step-header">
      <p className="step-header-label">
        Step {step} of 4 · {title}
      </p>
      <div className="step-header-script" title={scriptName}>
        <ScriptName name={scriptName} />
      </div>
    </div>
  );
}
