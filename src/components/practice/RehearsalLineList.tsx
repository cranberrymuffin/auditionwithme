import { useEffect, useRef } from "react";
import type { Step } from "../../types";
import { normalizeSpeaker } from "../../lib/script";
import TrackedWords from "../TrackedWords";

type LineMode = "full" | "first" | "hidden";
type Status = { title: string; detail: string; kind: string };

export default function RehearsalLineList({
  steps,
  currentIndex,
  selectedRole,
  lineMode,
  isMyLine,
  matchedWordCount,
  status,
  paused,
  canReplay,
  onJump,
  onPrev,
  onNext,
  onReplay,
  onNewTake,
  onToggleHide,
  onTogglePause,
}: {
  steps: Step[];
  currentIndex: number;
  selectedRole: string;
  lineMode: LineMode;
  isMyLine: boolean;
  matchedWordCount: number;
  status: Status;
  paused: boolean;
  canReplay: boolean;
  onJump: (index: number) => void;
  onPrev: () => void;
  onNext: () => void;
  onReplay: () => void;
  onNewTake: () => void;
  onToggleHide: () => void;
  onTogglePause: () => void;
}) {
  const activeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [currentIndex]);

  return (
    <div className="rehearsal-lines">
      {steps.map((step, index) => {
        const speaker = normalizeSpeaker(step.speaker);
        const isOwnLine = Boolean(selectedRole) && speaker === selectedRole;
        const active = index === currentIndex;
        const masked = isOwnLine && lineMode !== "full";
        const stageDirections = step.content.filter((line) => line.kind === "nonverbal");

        let lineContent;
        if (masked) {
          lineContent = lineMode === "hidden" ? "Line hidden" : `${step.verbalLine.split(/\s+/).slice(0, 3).join(" ")}…`;
        } else if (active && isMyLine) {
          lineContent = <TrackedWords text={step.verbalLine} matchedCount={matchedWordCount} />;
        } else {
          lineContent = step.verbalLine;
        }

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
                <strong>{speaker || "Stage direction"}</strong>
                {stageDirections.map((direction, dIndex) => <em key={dIndex}>{direction.text}</em>)}
                {step.verbalLine.trim() && <span className={masked && lineMode === "hidden" ? "is-masked" : ""}>{lineContent}</span>}
              </span>
            </button>
            {active && (
              <div className="rehearsal-line-active-panel">
                <div className={`rehearsal-status is-${status.kind}`}>
                  {status.kind === "listening" && <span className="mic-meter" aria-label="Microphone active"><i /><i /><i /><i /></span>}
                  <div><strong>{status.title}</strong><span>{status.detail}</span></div>
                </div>
                <div className="rehearsal-controls">
                  <button onClick={onReplay} disabled={!canReplay}>↻ Replay cue</button>
                  <button onClick={onNewTake} disabled={!canReplay} title="Regenerate the cue for a different read">✦ New take</button>
                  <button onClick={onToggleHide}>{lineMode === "hidden" ? "Show line" : "Hide line"}</button>
                  <button onClick={onTogglePause}>{paused ? "Resume" : "Pause"}</button>
                </div>
                <footer>
                  <button onClick={onPrev} disabled={index === 0}>← Previous</button>
                  <span>Line {index + 1} of {steps.length}</span>
                  <button className="next-line" onClick={onNext} disabled={index >= steps.length - 1}>Next →</button>
                </footer>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
