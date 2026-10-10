import type { ReactNode } from "react";

/**
 * A setup step's fold-away section (step 1's script, step 3's advanced
 * options): a row with a Show/Hide toggle and any other actions, then the
 * content while it's open.
 */
export default function Accordion({
  id,
  open,
  onOpenChange,
  showLabel,
  hideLabel,
  actions,
  className,
  children,
}: {
  /** The content's id, for the toggle's aria-controls. */
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  showLabel: string;
  hideLabel: string;
  /** More of the row, after the toggle. */
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`script-accordion ${className ?? ""}`}>
      <div className="script-accordion-actions">
        <button
          type="button"
          className="script-accordion-toggle"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => onOpenChange(!open)}
        >
          {open ? hideLabel : showLabel}
        </button>
        {actions}
      </div>
      {open && <div id={id}>{children}</div>}
    </div>
  );
}
