import { useEffect, useRef } from "react";
import type { Step } from "../../types";
import { normalizeSpeaker } from "../../lib/script";
import TrackedWords from "../TrackedWords";
import { useAudioDiagnostics } from "../../hooks/useAudioDiagnostics";

function formatLogTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

/**
 * TEMPORARY: live feed of audio/recording/mic events for chasing the mobile
 * cue-reliability issues. Always visible (not gated on error) so a failure
 * with no visible symptom still leaves a trail. Remove once resolved.
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
  matchedWordCount,
  status,
  canReplay,
  onJump,
  onPrev,
  onNext,
  onReplay,
  onStop,
}: {
  steps: Step[];
  currentIndex: number;
  selectedRole: string;
  lineMode: LineMode;
  isMyLine: boolean;
  matchedWordCount: number;
  status: Status;
  canReplay: boolean;
  onJump: (index: number) => void;
  onPrev: () => void;
  onNext: () => void;
  onReplay: () => void;
  onStop: () => void;
}) {
  const activeRef = useRef<HTMLDivElement | null>(null);

  // Align to the top, not the centre: the active block is line text plus a tall
  // control panel, and centring that on a short phone pushes the text itself
  // off the top of the script pane.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [currentIndex]);

  return (
    <div className="rehearsal-lines">
      {steps.map((step, index) => {
        const speaker = normalizeSpeaker(step.speaker);
        const isOwnLine = Boolean(selectedRole) && speaker === selectedRole;
        const active = index === currentIndex;
        const masked = isOwnLine && lineMode !== "full";
        const showTracking = !masked && active && isMyLine;

        // Render content in its real order so a stage direction that falls
        // mid-speech lands between the spoken segments it actually splits,
        // instead of every direction bunching ahead of the whole line.
        let wordOffset = 0;
        const bodyNodes = masked
          ? step.verbalLine.trim() && (
              <span className={lineMode === "hidden" ? "is-masked" : undefined}>
                {lineMode === "hidden" ? "Line hidden" : `${step.verbalLine.split(/\s+/).slice(0, 3).join(" ")}…`}
              </span>
            )
          : step.content.map((item, i) => {
              if (item.kind === "nonverbal") return <em key={i}>{item.text}</em>;
              const wordCount = item.text.split(/\s+/).filter(Boolean).length;
              // Wrapped in a real <span> (not left as TrackedWords' bare word
              // fragments) so `.rehearsal-line-copy > span` — which every
              // spoken segment relies on for its block layout — still matches
              // one element per segment instead of one per word.
              const node = (
                <span key={i}>
                  {showTracking
                    ? <TrackedWords text={item.text} matchedCount={Math.max(0, matchedWordCount - wordOffset)} />
                    : item.text}
                </span>
              );
              wordOffset += wordCount;
              return node;
            });

        return (
          <div
            key={index}
            ref={active ? activeRef : undefined}
            className={`rehearsal-line ${active ? "is-active" : ""} ${isOwnLine ? "is-user" : ""} ${index < currentIndex ? "is-past" : ""}`}
          >
            <button
              type="button"
              className="rehearsal-line-row"
              onClick={() => { if (!active) onJump(index); }}
              aria-current={active ? "step" : undefined}
              aria-label={`Line ${index + 1}, ${speaker || "stage direction"}${isOwnLine ? ", your line" : ""}`}
            >
              <span className="rehearsal-line-number">{String(index + 1).padStart(2, "0")}</span>
              <span className="rehearsal-line-copy">
                <strong>
                  {active && isOwnLine && <span className="rehearsal-live-dot" aria-hidden="true" />}
                  {speaker || "Stage direction"}
                </strong>
                {bodyNodes}
              </span>
            </button>
            {active && (
              <div className="rehearsal-line-active-panel">
                <AudioDebugPanel />
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
                <footer>
                  <button onClick={onPrev} disabled={index === 0}>← Previous</button>
                  <span>Line {index + 1} of {steps.length}</span>
                  {index >= steps.length - 1
                    ? <button className="next-line" onClick={onStop}>Stop</button>
                    : <button className="next-line" onClick={onNext}>Next →</button>}
                </footer>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
