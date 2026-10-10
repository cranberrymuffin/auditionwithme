// The four practice steps' names, as the header's bars announce them.
const STEPS = ["Rehearsal setup", "Cast yourself", "Direct your scene partners", "Rehearsal"];

/**
 * The bars in a practice setup step's header, one per step and all the
 * same width: done steps filled (each a button back to that step), the
 * current one coral, later ones outlined. The way back between setup steps
 * — there's no separate Back button.
 *
 * The bars themselves are decorative; each step's name and status is
 * spoken from visually hidden text, the current step is marked with
 * aria-current, and the done steps are real buttons with a tall hit area.
 */
export default function StepProgress({
  current,
  onGoToStep,
}: {
  /** 1-based, like the step counters. */
  current: number;
  /** Back to an earlier step (1-based). */
  onGoToStep?: (step: number) => void;
}) {
  return (
    <nav className="setup-progress" aria-label="Practice setup steps">
      <ol>
        {STEPS.map((name, index) => {
          const step = index + 1;
          const done = step < current;
          const label = `Step ${step} of ${STEPS.length}: ${name}`;
          const bar = (
            <span
              className={`step-bar ${done ? "is-done" : step === current ? "is-active" : ""}`}
              aria-hidden="true"
            />
          );
          if (done && onGoToStep) {
            return (
              <li key={name}>
                <button
                  type="button"
                  className="step-bar-button"
                  title={`Back to ${name}`}
                  onClick={() => onGoToStep(step)}
                >
                  {bar}
                  <span className="sr-only">{label}, done. Go back to this step</span>
                </button>
              </li>
            );
          }
          return (
            <li key={name} aria-current={step === current ? "step" : undefined}>
              <span className="step-bar-slot">
                {bar}
                <span className="sr-only">
                  {label}, {step === current ? "current step" : done ? "done" : "not started"}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
