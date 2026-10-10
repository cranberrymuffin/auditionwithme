import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * The cards of a setup step's cast (step 2's roles, step 3's voices): two
 * to a row, wrapping onto as many rows as the cast needs, an odd last card
 * centered under the others. Everyone's always in view — no sideways
 * scrolling. On phones, one column.
 */
export default function CastGrid<T>({
  items,
  label,
  role,
  renderCard,
}: {
  items: T[];
  label: string;
  /** E.g. "radiogroup" when the cards are radios. */
  role?: string;
  /** `index` is the item's place in `items`. */
  renderCard: (item: T, index: number) => ReactNode;
}) {
  return (
    <div
      className={`role-grid ${items.length === 1 ? "is-single" : ""}`}
      role={role}
      aria-label={label}
    >
      {items.map((item, index) => renderCard(item, index))}
    </div>
  );
}

/** One card in a CastGrid: a mark on the left (a radio, a play button),
 * then the name, a detail line and a quoted line from the script. */
export function CastCard({
  mark,
  name,
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
      className={`role-option ${active ? "is-selected" : ""} ${className}`}
      {...buttonProps}
    >
      <span className="role-radio" aria-hidden="true">
        {mark}
      </span>
      <span className="role-option-copy">
        <strong>{name}</strong>
        <small>{detail}</small>
        <q>{quote.length > 120 ? `${quote.slice(0, 120)}…` : quote}</q>
      </span>
    </button>
  );
}
