import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * The cards of a setup step's cast (step 2's roles, step 3's voices): one
 * row, or two split evenly and laid like bricks once one would overflow,
 * scrolling sideways when they don't fit. On phones, one column.
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
  /** `index` is the item's place in `items`, across both rows. */
  renderCard: (item: T, index: number) => ReactNode;
}) {
  // A row fits two cards; past that, a second row, split evenly, the first
  // taking the odd one out.
  const split = items.length <= 2 ? items.length : Math.ceil(items.length / 2);
  const rows = [items.slice(0, split), items.slice(split)].filter(
    (row) => row.length,
  );

  return (
    <div className="role-grid" role={role} aria-label={label}>
      <div className="role-rows">
        {rows.map((row, rowIndex) => (
          <div className="role-row" key={rowIndex}>
            {row.map((item, i) => renderCard(item, rowIndex * split + i))}
          </div>
        ))}
      </div>
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
