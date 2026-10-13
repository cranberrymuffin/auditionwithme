import { useEffect, useRef } from "react";
import type { Step } from "../../types";
import { normalizeSpeaker, splitStepContent } from "../../lib/script";
import { useAudioDiagnostics } from "../../hooks/useAudioDiagnostics";

function formatLogTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

/**
 * Whether the audio debug panel shows. Off for actors; a tester chasing the
 * mobile cue-reliability issues turns it on with ?audioDebug=1 (it sticks on
 * that device until ?audioDebug=0). Events are logged either way.
 */
function audioDebugEnabled(): boolean {
  try {
    const param = new URLSearchParams(window.location.search).get("audioDebug");
    if (param === "1") localStorage.setItem("awm:audioDebug", "1");
    if (param === "0") localStorage.removeItem("awm:audioDebug");
    return localStorage.getItem("awm:audioDebug") === "1";
  } catch {
    return false;
  }
}
const SHOW_AUDIO_DEBUG = audioDebugEnabled();

/**
 * Live feed of audio/recording/mic events for chasing the mobile
 * cue-reliability issues — see audioDebugEnabled() for how it's shown.
 */
function AudioDebugPanel() {
  const log = useAudioDiagnostics();
  const recent = log.slice(-10);
  return (
    <div className="audio-debug-panel">
      <strong>Audio debug log</strong>
      {recent.length === 0 && <div>(no events yet)</div>}
      {recent.map((entry, i) => (
        <div key={i}>
          <span>{formatLogTime(entry.time)}</span> <span>[{entry.tag}]</span> {entry.message}
        </div>
      ))}
    </div>
  );
}

type LineMode = "full" | "hidden";
type Status = { title: string; detail: string; kind: string };

export default function RehearsalLineList({
  steps,
  currentIndex,
  selectedRole,
  lineMode,
  isMyLine,
  status,
  canReplay,
  onJump,
  onPrev,
  onNext,
  onReplay,
  onStop,
  stopLabel,
}: {
  steps: Step[];
  currentIndex: number;
  selectedRole: string;
  lineMode: LineMode;
  isMyLine: boolean;
  status: Status;
  canReplay: boolean;
  onJump: (index: number) => void;
  onPrev: () => void;
  onNext: () => void;
  onReplay: () => void;
  onStop: () => void;
  /** The last line's button: ends and saves the take, or finishes a run. */
  stopLabel: string;
}) {
  const activeRef = useRef<HTMLDivElement | null>(null);

  // Align to the top, not the centre: the active block is line text plus a tall
  // control panel, and centring that on a short phone pushes the text itself
  // off the top of the script pane. Only the script pane scrolls —
  // scrollIntoView would also scroll the page around it (overflow: hidden
  // still scrolls programmatically), sliding the line, and any scene heading
  // above it, under the sticky header.
  useEffect(() => {
    const line = activeRef.current;
    const pane = line?.closest<HTMLElement>(".rehearsal-center");
    if (!line || !pane) return;
    const top = line.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop - 12;
    pane.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }, [currentIndex]);

  const isLastStep = currentIndex >= steps.length - 1;
  // Touch screens get a big Next pinned above the thumb for the actor's own
  // lines (see .rehearsal-floating-next): on a long speech the footer's Next
  // sits below the fold, exactly when detection is most likely to stall.
  const showFloatingNext = isMyLine && !isLastStep;

  return (
    <div className="rehearsal-lines">
      {steps.map((step, index) => {
        const speaker = normalizeSpeaker(step.speaker);
        const isOwnLine = Boolean(selectedRole) && speaker === selectedRole;
        const active = index === currentIndex;
        const masked = isOwnLine && lineMode !== "full";

        // The scene heading a step opens, if any, prints as a divider above
        // it; directions before the speech sit above the speaker's name.
        const { sceneHeading, leadIn, speech } = splitStepContent(step);

        // Render the speech in its real order so a stage direction that falls
        // mid-speech lands between the spoken segments it actually splits,
        // instead of every direction bunching ahead of the whole line.
        const bodyNodes = masked
          ? step.verbalLine.trim() && (
              <span className={lineMode === "hidden" ? "is-masked" : undefined}>
                {lineMode === "hidden" ? "Line hidden" : `${step.verbalLine.split(/\s+/).slice(0, 3).join(" ")}…`}
              </span>
            )
          : speech.map((item, i) =>
              item.kind === "nonverbal" ? <em key={i}>{item.text}</em> : <span key={i}>{item.text}</span>,
            );

        return (
          <div
            key={index}
            ref={active ? activeRef : undefined}
            className={`rehearsal-line ${active ? "is-active" : ""} ${isOwnLine ? "is-user" : ""} ${index < currentIndex ? "is-past" : ""}`}
          >
            {sceneHeading && (
              <p className="rehearsal-scene-heading">
                <span className="sr-only">New scene: </span>
                {sceneHeading}
              </p>
            )}
            <button
              type="button"
              className="rehearsal-line-row"
              onClick={() => { if (!active) onJump(index); }}
              aria-current={active ? "step" : undefined}
              aria-label={`Line ${index + 1}, ${speaker || "stage direction"}${isOwnLine ? ", your line" : ""}`}
            >
              <span className="rehearsal-line-number">{String(index + 1).padStart(2, "0")}</span>
              <span className="rehearsal-line-copy">
                {leadIn.length > 0 && (
                  <span className="rehearsal-line-action">
                    {leadIn.map((text, i) => <span key={i}>{text}</span>)}
                  </span>
                )}
                <strong>
                  {active && isOwnLine && <span className="rehearsal-live-dot" aria-hidden="true" />}
                  {speaker || "Stage direction"}
                  {isOwnLine && <span className="rehearsal-you-tag" aria-hidden="true">You</span>}
                </strong>
                {bodyNodes}
              </span>
            </button>
            {active && (
              <div className="rehearsal-line-active-panel">
                {SHOW_AUDIO_DEBUG && <AudioDebugPanel />}
                {status.kind === "error" && (
                  <>
                    <div className={`rehearsal-status is-${status.kind}`}>
                      <span className="mic-meter" aria-hidden="true"><i /><i /><i /><i /></span>
                      <div><strong>{status.title}</strong><span>{status.detail}</span></div>
                    </div>
                    <div className="rehearsal-controls">
                      <button onClick={onReplay} disabled={!canReplay}>↻ Replay cue</button>
                    </div>
                  </>
                )}
                <footer className={showFloatingNext ? "has-floating-next" : undefined}>
                  <button onClick={onPrev} disabled={index === 0}>← Previous</button>
                  <span>Line {index + 1} of {steps.length}</span>
                  {index >= steps.length - 1
                    ? <button className="next-line" onClick={onStop}>{stopLabel}</button>
                    : <button className="next-line" onClick={onNext}>Next →</button>}
                </footer>
              </div>
            )}
          </div>
        );
      })}
      {showFloatingNext && (
        <button type="button" className="rehearsal-floating-next" onClick={onNext} aria-label="Next line">
          Next →
        </button>
      )}
    </div>
  );
}
