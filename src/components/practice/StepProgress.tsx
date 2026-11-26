import { STEP_NAMES } from "./stepNames";

const STEPS = STEP_NAMES;

/**
 * The numbered steps in a practice setup step's header (the shared .steps
 * list): done steps are buttons back to that step, the current one is
 * marked, later ones are muted. The way back between setup steps — there's
 * no separate Back button up here.
 *
 * What's drawn (number, name) is decorative; each step's name and status is
 * spoken from visually hidden text, the current step is marked with
 * aria-current, and the done steps are real buttons with a tall hit area.
 * Narrow screens show the numbers and only the current step's name.
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
      <ol className="steps">
        {STEPS.map((name, index) => {
          const step = index + 1;
          const done = step < current;
          const label = `Step ${step} of ${STEPS.length}: ${name}`;
          const mark = (
            <>
              <span className="setup-step-num" aria-hidden="true">
                {String(step).padStart(2, "0")}
              </span>
              <span className="setup-step-name" aria-hidden="true">
                {name}
              </span>
            </>
          );
          if (done && onGoToStep) {
            return (
              <li key={name} className="is-done">
                <button
                  type="button"
                  className="setup-step"
                  title={`Back to ${name}`}
                  onClick={() => onGoToStep(step)}
                >
                  {mark}
                  <span className="sr-only">{label}, done. Go back to this step</span>
                </button>
              </li>
            );
          }
          return (
            <li
              key={name}
              className={done ? "is-done" : undefined}
              aria-current={step === current ? "step" : undefined}
            >
              <span className="setup-step">
                {mark}
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
