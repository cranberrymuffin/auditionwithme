import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * A setup step's cast (step 2's roles, step 3's voices) as a ruled list,
 * one character to a row, the way a cast list reads on a call sheet.
 * Everyone's always in view — nothing scrolls sideways.
 */
export default function CastGrid<T>({
  items,
  label,
  role,
  renderCard,
}: {
  items: T[];
  label: string;
  /** E.g. "radiogroup" when the rows are radios. */
  role?: string;
  /** `index` is the item's place in `items`. */
  renderCard: (item: T, index: number) => ReactNode;
}) {
  return (
    <div className="cast-list" role={role} aria-label={label}>
      {items.map((item, index) => renderCard(item, index))}
    </div>
  );
}

/** One row in a CastGrid: a mark on the left (a radio, a play button),
 * then the character's cue, a detail line and a line of theirs from the
 * script. */
export function CastCard({
  mark,
  name,
  tag,
  detail,
  quote,
  active,
  buttonRef,
  className = "",
  ...buttonProps
}: {
  /** In the circle on the left. */
  mark: ReactNode;
  name: string;
  /** A short state beside the name ("You"). */
  tag?: ReactNode;
  detail: string;
  quote: string;
  /** Selected (step 2) or playing (step 3). */
  active: boolean;
  buttonRef?: (element: HTMLButtonElement | null) => void;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      ref={buttonRef}
      className={`cast-row ${active ? "is-selected" : ""} ${className}`}
      {...buttonProps}
    >
      <span className="cast-mark" aria-hidden="true">
        {mark}
      </span>
      <span className="cast-copy">
        <span className="cast-head">
          <strong className="sides-cue">
            {name}
            {tag}
          </strong>
          <small>{detail}</small>
        </span>
        <q>{quote.length > 120 ? `${quote.slice(0, 120)}…` : quote}</q>
      </span>
    </button>
  );
}
