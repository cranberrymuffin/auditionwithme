/** The row closing a setup step: Back on the left, the next step on the
 * right, styled like step 1's actions. */
export default function SetupActions({
  onBack,
  nextLabel,
  onNext,
  nextDisabled,
}: {
  onBack: () => void;
  nextLabel: string;
  onNext: () => void;
  nextDisabled?: boolean;
}) {
  return (
    <div className="script-accordion-actions role-actions">
      <button
        type="button"
        className="script-accordion-toggle"
        onClick={onBack}
      >
        Back
      </button>
      <button
        type="button"
        className="script-accordion-toggle script-accordion-next"
        disabled={nextDisabled}
        onClick={onNext}
      >
        {nextLabel}
      </button>
    </div>
  );
}
