import { memo, useEffect, useMemo, useRef, type RefObject } from "react";
import type { Step } from "../../types";
import { normalizeSpeaker, splitStepContent } from "../../lib/script";
import TrackedWords from "../TrackedWords";
import { useAudioDiagnostics } from "../../hooks/useAudioDiagnostics";

function formatLogTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

/**
 * Whether the audio debug panel shows. Always on in dev; off for actors in
 * production, where a tester chasing the mobile cue-reliability issues turns
 * it on with ?audioDebug=1 (it sticks on that device until ?audioDebug=0).
 * Events are logged either way.
 */
function audioDebugEnabled(): boolean {
  if (import.meta.env.DEV) return true;
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

type LineRowProps = {
  step: Step;
  index: number;
  selectedRole: string;
  lineMode: LineMode;
  active: boolean;
  past: boolean;
  /** Only ever set on the active row: the rest stay as they are (memo) while
   * every Scribe partial moves the count. */
  matchedWordCount: number;
  showTracking: boolean;
  activeRef: RefObject<HTMLDivElement | null> | undefined;
  onJump: (index: number) => void;
};

const RehearsalLine = memo(function RehearsalLine({
  step,
  index,
  selectedRole,
  lineMode,
  active,
  past,
  matchedWordCount,
  showTracking,
  activeRef,
  onJump,
}: LineRowProps) {
  const speaker = normalizeSpeaker(step.speaker);
  const isOwnLine = Boolean(selectedRole) && speaker === selectedRole;
  const masked = isOwnLine && lineMode !== "full";

  // The scene heading a step opens, if any, prints as a divider above
  // it; directions before the speech sit above the speaker's name.
  const { sceneHeading, leadIn, speech } = useMemo(() => splitStepContent(step), [step]);

  // Render the speech in its real order so a stage direction that falls
  // mid-speech lands between the spoken segments it actually splits,
  // instead of every direction bunching ahead of the whole line.
  let wordOffset = 0;
  const bodyNodes = masked
    ? step.verbalLine.trim() && <span className="is-masked">Line hidden</span>
    : speech.map((item, i) => {
        if (item.kind === "nonverbal") return <em key={i} className="sides-paren">{item.text}</em>;
        const wordCount = item.text.split(/\s+/).filter(Boolean).length;
        // Wrapped in a real <span> (not left as TrackedWords' bare word
        // fragments) so `.sides-dialogue > span` — the highlighter over
        // the actor's own lines — matches one element per spoken segment
        // instead of one per word.
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
      ref={activeRef}
      className={`rehearsal-line ${active ? "is-active" : ""} ${isOwnLine ? "is-yours" : ""}`}
    >
      {sceneHeading && (
        <p className="sides-slug rehearsal-scene-heading">
          <span className="sr-only">New scene: </span>
          {sceneHeading}
        </p>
      )}
      <button
        type="button"
        className={`sides-line rehearsal-line-row ${active ? "is-active" : ""} ${isOwnLine ? "is-yours" : ""} ${past ? "is-past" : ""}`}
        onClick={() => { if (!active) onJump(index); }}
        aria-current={active ? "step" : undefined}
        aria-label={`Line ${index + 1}, ${speaker || "stage direction"}${isOwnLine ? ", your line" : ""}`}
      >
        <span className="sides-num">{String(index + 1).padStart(2, "0")}</span>
        <span className="rehearsal-line-copy">
          {leadIn.length > 0 && (
            <span className="sides-action rehearsal-line-action">
              {leadIn.map((text, i) => <span key={i}>{text}</span>)}
            </span>
          )}
          <span className="sides-cue">
            {speaker || "Stage direction"}
            {isOwnLine && <span className="tag tag-accent" aria-hidden="true">You</span>}
          </span>
          <span className="sides-dialogue">{bodyNodes}</span>
        </span>
      </button>
      {active && SHOW_AUDIO_DEBUG && (
        <div className="rehearsal-line-active-panel">
          <AudioDebugPanel />
        </div>
      )}
    </div>
  );
});

export default function RehearsalLineList({
  steps,
  currentIndex,
  selectedRole,
  lineMode,
  isMyLine,
  matchedWordCount,
  onJump,
}: {
  steps: Step[];
  currentIndex: number;
  selectedRole: string;
  lineMode: LineMode;
  isMyLine: boolean;
  matchedWordCount: number;
  onJump: (index: number) => void;
}) {
  const activeRef = useRef<HTMLDivElement | null>(null);

  // Align to the top, not the centre: on a short phone, centring a long
  // line pushes its opening words off the top of the script pane. Only the script pane scrolls —
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

  return (
    <div className="sides rehearsal-lines">
      {steps.map((step, index) => {
        const active = index === currentIndex;
        return (
          <RehearsalLine
            key={index}
            step={step}
            index={index}
            selectedRole={selectedRole}
            lineMode={lineMode}
            active={active}
            past={index < currentIndex}
            matchedWordCount={active ? matchedWordCount : 0}
            showTracking={active && isMyLine}
            activeRef={active ? activeRef : undefined}
            onJump={onJump}
          />
        );
      })}
    </div>
  );
}
