export type RehearsalStatusKind =
  | "you"
  | "hint"
  | "partner"
  | "waiting"
  | "paused"
  | "error"
  | "done";

export type RehearsalStatus = {
  kind: RehearsalStatusKind;
  /** Whose turn it is, in a word or two: read from across the room. */
  title: string;
  /** What's happening, or what the actor should do about it. */
  detail: string;
};

// A shape per state, so whose turn it is never rests on colour alone.
function StatusIcon({ kind }: { kind: RehearsalStatusKind }) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (kind) {
    case "you":
    case "hint":
      return (
        <svg {...common}>
          <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
          <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
        </svg>
      );
    case "partner":
      return (
        <svg {...common}>
          <path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" />
          <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" />
        </svg>
      );
    case "paused":
      return (
        <svg {...common}>
          <rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" />
          <rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" />
        </svg>
      );
    case "error":
      return (
        <svg {...common}>
          <path d="M12 3 2.5 20h19L12 3z" />
          <path d="M12 10v4.5M12 17.5v.01" />
        </svg>
      );
    case "done":
      return (
        <svg {...common}>
          <path d="m5 12.5 4.5 4.5L19 7.5" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <path d="M6 12h.01M12 12h.01M18 12h.01" strokeWidth={3} />
        </svg>
      );
  }
}

/**
 * Whose turn it is, always on screen and legible from a phone propped up
 * across the room. The rehearsal's one live region: the script pane beside
 * it re-renders on every recognised word, far too chatty to announce.
 */
export default function RehearsalStatusStrip({ status }: { status: RehearsalStatus }) {
  const isError = status.kind === "error";
  const text = (
    <>
      <strong>{status.title}</strong>
      {status.detail && <span>{status.detail}</span>}
    </>
  );
  return (
    // A hint is still the actor's turn: it keeps the coral surface (.turn.is-you)
    // and says what to do in its detail.
    <div className={`turn rehearsal-turn is-${status.kind} ${status.kind === "hint" ? "is-you" : ""}`}>
      <StatusIcon kind={status.kind} />
      {/* Both regions stay mounted: a live region only announces changes
          made after it exists. */}
      <p aria-live="polite" aria-atomic="true">{!isError && text}</p>
      <p role="alert" aria-atomic="true">{isError && text}</p>
    </div>
  );
}
