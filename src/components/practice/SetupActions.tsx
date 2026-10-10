/** The row closing a setup step: Back on the left, the step's one primary
 * button — on to the next step — on the right. */
export default function SetupActions({
  onBack,
  nextLabel,
  onNext,
  nextDisabled,
  nextHint,
}: {
  onBack: () => void;
  nextLabel: string;
  onNext: () => void;
  nextDisabled?: boolean;
  /** Says what's missing while the next button is disabled. */
  nextHint?: string;
}) {
  return (
    <div className="script-accordion-actions role-actions">
      <button
        type="button"
        className="btn-secondary"
        onClick={onBack}
      >
        Back
      </button>
      <button
        type="button"
        className="setup-next"
        disabled={nextDisabled}
        aria-describedby={nextDisabled && nextHint ? "setup-next-hint" : undefined}
        onClick={onNext}
      >
        {nextLabel} <span aria-hidden="true">→</span>
      </button>
      {nextDisabled && nextHint && (
        <p id="setup-next-hint" className="setup-next-hint">
          {nextHint}
        </p>
      )}
    </div>
  );
}
