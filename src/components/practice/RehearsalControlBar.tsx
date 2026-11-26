import type { ReactNode } from "react";

const icon = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function BarButton({
  label,
  shortLabel,
  shortcut,
  className,
  children,
  ...button
}: {
  /** The accessible name, and the label where there's room. */
  label: string;
  /** What a narrow phone shows under the icon. */
  shortLabel: string;
  /** Keyboard shortcut, shown where there's a keyboard to use it. */
  shortcut?: string;
  children: ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={className} aria-label={label} title={label} {...button}>
      {children}
      <span className="rehearsal-bar-label" data-short={shortLabel} aria-hidden="true">
        <span>{label}</span>
      </span>
      {shortcut && <kbd aria-hidden="true">{shortcut}</kbd>}
    </button>
  );
}

/**
 * The rehearsal's controls, in every mode (taping, just running lines,
 * listening): always on screen and reachable by touch, so nothing depends
 * on a keyboard shortcut or on a take being recorded.
 */
export default function RehearsalControlBar({
  disabled,
  paused,
  onTogglePause,
  canPrev,
  onPrev,
  canNext,
  onNext,
  canReplay,
  onReplay,
  linesHidden,
  onToggleLines,
  endLabel,
  ending,
  onEnd,
}: {
  /** The countdown, or a take being saved: nothing to control yet/any more. */
  disabled: boolean;
  paused: boolean;
  onTogglePause: () => void;
  canPrev: boolean;
  onPrev: () => void;
  canNext: boolean;
  onNext: () => void;
  canReplay: boolean;
  onReplay: () => void;
  linesHidden: boolean;
  /** Absent when the actor isn't reading a role: no lines of their own. */
  onToggleLines?: () => void;
  /** "End take" while taping, "Finish" otherwise. */
  endLabel: string;
  ending: boolean;
  onEnd: () => void;
}) {
  return (
    <div className="rehearsal-bar" role="group" aria-label="Rehearsal controls">
      <BarButton label="Previous line" shortLabel="Back" shortcut="←" onClick={onPrev} disabled={disabled || !canPrev}>
        <svg {...icon}><path d="M15 5 8 12l7 7" /></svg>
      </BarButton>
      <BarButton
        label={paused ? "Resume" : "Pause"}
        shortLabel={paused ? "Resume" : "Pause"}
        shortcut="Space"
        onClick={onTogglePause}
        disabled={disabled}
      >
        {paused ? (
          <svg {...icon}><path d="M7 4.5v15l12-7.5-12-7.5z" fill="currentColor" /></svg>
        ) : (
          <svg {...icon}>
            <rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" />
            <rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" />
          </svg>
        )}
      </BarButton>
      <BarButton label="Replay cue" shortLabel="Replay" shortcut="R" onClick={onReplay} disabled={disabled || !canReplay}>
        <svg {...icon}><path d="M4 12a8 8 0 1 0 2.6-5.9" /><path d="M4 4v5h5" /></svg>
      </BarButton>
      {onToggleLines && (
        <BarButton
          label={linesHidden ? "Show my lines" : "Hide my lines"}
          shortLabel={linesHidden ? "Show lines" : "Hide lines"}
          shortcut="H"
          onClick={onToggleLines}
          disabled={disabled}
        >
          {linesHidden ? (
            <svg {...icon}>
              <path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" />
              <circle cx="12" cy="12" r="2.5" />
            </svg>
          ) : (
            <svg {...icon}>
              <path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" />
              <path d="m4 4 16 16" />
            </svg>
          )}
        </BarButton>
      )}
      <BarButton
        label="Next line"
        shortLabel="Next"
        shortcut="→"
        className="is-next"
        onClick={onNext}
        disabled={disabled || !canNext}
      >
        <svg {...icon}><path d="m9 5 7 7-7 7" /></svg>
      </BarButton>
      <BarButton
        label={ending ? "Saving…" : endLabel}
        shortLabel={ending ? "Saving…" : endLabel === "End take" ? "End" : endLabel}
        className="is-end"
        onClick={onEnd}
        disabled={disabled || ending}
      >
        <svg {...icon}><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" /></svg>
      </BarButton>
    </div>
  );
}
