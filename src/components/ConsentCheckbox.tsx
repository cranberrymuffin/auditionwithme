import { useId, type ReactNode, type Ref } from "react";

type Props = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
  /** Shown under the box and tied to it once a submit found it unticked.
   * Passing this prop at all (even null) hands validation to the form,
   * instead of the browser's own "check this box" bubble. */
  error?: string | null;
  inputRef?: Ref<HTMLInputElement>;
};

// A required agreement checkbox: the Terms/NDA at signup, and the Terms and
// auto-renewal consent at checkout. Links in the label open the document in
// a new tab so the form keeps its state.
export default function ConsentCheckbox({ checked, onChange, children, error, inputRef }: Props) {
  const errorId = useId();
  const formValidates = error !== undefined;
  return (
    <>
      <label className="consent-check">
        <input
          ref={inputRef}
          type="checkbox"
          checked={checked}
          required={!formValidates}
          aria-required={formValidates ? true : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{children}</span>
      </label>
      {error && (
        <p id={errorId} className="consent-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
