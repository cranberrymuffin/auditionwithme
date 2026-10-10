import { useState } from "react";

/** An auth-card password input with a Show/Hide toggle inside its right edge. */
export default function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  minLength,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: "current-password" | "new-password";
  minLength?: number;
  /** Shown under the field and tied to it for screen readers. */
  hint?: string;
}) {
  const [visible, setVisible] = useState(false);
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <div className={`password-field ${hint ? "has-hint" : ""}`}>
        <input
          id={id}
          type={visible ? "text" : "password"}
          value={value}
          autoComplete={autoComplete}
          minLength={minLength}
          required
          aria-describedby={hintId}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          className="password-toggle"
          aria-pressed={visible}
          aria-controls={id}
          onClick={() => setVisible((shown) => !shown)}
        >
          {visible ? "Hide" : "Show"}
        </button>
      </div>
      {hint && (
        <p id={hintId} className="auth-hint">
          {hint}
        </p>
      )}
    </>
  );
}
