import type { ReactNode } from "react";

type Props = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
};

// A required agreement checkbox: the Terms/NDA at signup, and the Terms and
// auto-renewal consent at checkout. Links in the label open the document in
// a new tab so the form keeps its state.
export default function ConsentCheckbox({ checked, onChange, children }: Props) {
  return (
    <label className="consent-check">
      <input
        type="checkbox"
        checked={checked}
        required
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{children}</span>
    </label>
  );
}
