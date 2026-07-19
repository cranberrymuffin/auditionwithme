import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { Step } from "../../types";
import { normalizeSpeaker } from "../../lib/script";
import { useTtsPlayer } from "../../hooks/useTtsPlayer";
import { useScribeTracking } from "../../hooks/useScribeTracking";
import TrackedWords from "../TrackedWords";
import ScriptRail from "./ScriptRail";

type PlaybackState = "waiting" | "playing" | "ready" | "paused" | "error";
type LineMode = "full" | "first" | "hidden";

export default function Rehearsal({ steps, selectedRole, characterVoices, onBack, languageCode, fileName }: {
  steps: Step[];
  selectedRole: string;
  characterVoices: Record<string, string>;
  onBack: () => void;
  languageCode: string;
  fileName: string;
}) {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [autoAdvance, setAutoAdvance] = useState(true);
  const [paused, setPaused] = useState(false);
  const [playbackState, setPlaybackState] = useState<PlaybackState>("waiting");
  const [lineMode, setLineMode] = useState<LineMode>("full");
  const [railOpen, setRailOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const autoAdvanceRef = useRef(autoAdvance);
  autoAdvanceRef.current = autoAdvance;
  const { play, prefetch, stop } = useTtsPlayer();

  const speakers = useMemo(() => [...new Set(steps.map((step) => normalizeSpeaker(step.speaker)).filter(Boolean))], [steps]);
  const currentStep = steps[currentStepIndex];
  const currentSpeaker = normalizeSpeaker(currentStep?.speaker ?? "");
  const isMyLine = Boolean(selectedRole) && currentSpeaker === selectedRole;
  const lineWordCount = (currentStep?.verbalLine ?? "").split(/\s+/).filter(Boolean).length;
  const { matchedWordCount, listening } = useScribeTracking(isMyLine && !paused, currentStep?.verbalLine ?? "", languageCode);

  const goTo = useCallback((index: number) => {
    stop();
    setPaused(false);
    setPlaybackState("waiting");
    setCurrentStepIndex(Math.max(0, Math.min(index, steps.length - 1)));
  }, [stop, steps.length]);
  const goNext = useCallback(() => goTo(currentStepIndex + 1), [goTo, currentStepIndex]);
  const goPrev = useCallback(() => goTo(currentStepIndex - 1), [goTo, currentStepIndex]);
  const goNextRef = useRef(goNext);
  goNextRef.current = goNext;

  useEffect(() => {
    if (paused) return;
    const step = steps[currentStepIndex];
    if (!step) return;
    const speaker = normalizeSpeaker(step.speaker);
    if (selectedRole && speaker === selectedRole) {
      setPlaybackState("ready");
      return;
    }
    const next = steps.slice(currentStepIndex + 1).find((item) => item.verbalLine.trim() && (!selectedRole || normalizeSpeaker(item.speaker) !== selectedRole));
    if (next) prefetch(next.verbalLine, characterVoices[normalizeSpeaker(next.speaker)]);
    if (!step.verbalLine.trim()) {
      setPlaybackState("ready");
      const timer = setTimeout(() => { if (autoAdvanceRef.current) goNextRef.current(); }, 1200);
      return () => clearTimeout(timer);
    }
    const controller = new AbortController();
    setPlaybackState("playing");
    play(step.verbalLine, characterVoices[speaker], {
      signal: controller.signal,
      onEnded: () => {
        setPlaybackState("ready");
        if (autoAdvanceRef.current) goNextRef.current();
      },
    }).catch((error) => {
      if (error?.name !== "AbortError") setPlaybackState("error");
    });
    return () => { controller.abort(); stop(); };
  }, [currentStepIndex, steps, selectedRole, characterVoices, paused, play, prefetch, stop]);

  const lineDetected = isMyLine && lineWordCount > 0 && matchedWordCount >= lineWordCount;
  useEffect(() => {
    if (!lineDetected) return;
    const timer = setTimeout(() => { if (autoAdvanceRef.current) goNextRef.current(); }, 800);
    return () => clearTimeout(timer);
  }, [lineDetected]);

  const cueIndex = isMyLine
    ? [...steps.slice(0, currentStepIndex).keys()].reverse().find((index) => steps[index].verbalLine.trim())
    : currentStepIndex;
  const cueStep = cueIndex === undefined ? null : steps[cueIndex];
  const cueSpeaker = normalizeSpeaker(cueStep?.speaker ?? "");
  const userStep = isMyLine
    ? currentStep
    : selectedRole
      ? steps.slice(currentStepIndex + 1).find((step) => normalizeSpeaker(step.speaker) === selectedRole)
      : null;

  const replayCue = useCallback(() => {
    if (!cueStep?.verbalLine.trim()) return;
    stop();
    setPaused(false);
    setPlaybackState("playing");
    play(cueStep.verbalLine, characterVoices[cueSpeaker], {
      onEnded: () => setPlaybackState(isMyLine ? "ready" : "waiting"),
    }).catch(() => setPlaybackState("error"));
  }, [cueStep, cueSpeaker, characterVoices, isMyLine, play, stop]);

  const togglePause = useCallback(() => {
    setPaused((value) => {
      if (!value) { stop(); setPlaybackState("paused"); }
      return !value;
    });
  }, [stop]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.matches("input, select, textarea, button")) return;
      if (event.key === "ArrowRight") goNext();
      if (event.key === "ArrowLeft") goPrev();
      if (event.key.toLowerCase() === "r") replayCue();
      if (event.key.toLowerCase() === "h") setLineMode((mode) => mode === "hidden" ? "full" : "hidden");
      if (event.code === "Space") { event.preventDefault(); togglePause(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goNext, goPrev, replayCue, togglePause]);

  if (!currentStep) return null;
  const progress = ((currentStepIndex + 1) / steps.length) * 100;
  const status = paused
    ? { title: "Rehearsal paused", detail: "Resume when you’re ready.", kind: "paused" }
    : playbackState === "error"
      ? { title: "Cue playback failed", detail: "Replay the cue or continue manually.", kind: "error" }
      : lineDetected
        ? { title: "Got it", detail: autoAdvance ? "The next cue will play automatically." : "Continue when you’re ready.", kind: "detected" }
        : isMyLine && listening
          ? { title: "Listening for your line…", detail: autoAdvance ? "The next cue will play after your line is detected." : "Auto-flow is off; advance when ready.", kind: "listening" }
          : isMyLine
            ? { title: "Your line", detail: "Microphone unavailable. Read aloud, then continue.", kind: "ready" }
            : playbackState === "playing"
              ? { title: `${currentSpeaker || "Scene partner"} is speaking…`, detail: "Listen for your cue.", kind: "playing" }
              : { title: "Cue complete", detail: autoAdvance ? "Moving to the next line." : "Continue when you’re ready.", kind: "ready" };

  const visibleUserLine = userStep?.verbalLine ?? "";
  const firstWords = visibleUserLine.split(/\s+/).slice(0, 3).join(" ");
  const stageDirections = currentStep.content.filter((line) => line.kind === "nonverbal");

  return (
    <main className="rehearsal-page">
      <header className="rehearsal-header">
        <div className="rehearsal-context">
          <button onClick={onBack} aria-label="Back to role and voice setup" title="Back to setup">←</button>
          <span title={fileName}>{fileName}</span>
        </div>
        <p><strong>Rehearsal</strong><span>Line {currentStepIndex + 1} of {steps.length}</span></p>
        <div><button className="mobile-script-toggle" onClick={() => setRailOpen(true)}>Transcript</button><button className="controls-toggle" onClick={() => setSettingsOpen((open) => !open)} aria-expanded={settingsOpen}>Controls</button><Link to="/">Exit</Link></div>
      </header>
      <div className="rehearsal-progress"><i style={{ width: `${progress}%` }} /></div>

      <div className="rehearsal-workspace">
        <aside className={`rehearsal-transcript ${railOpen ? "is-open" : ""}`}>
          <button className="drawer-close" onClick={() => setRailOpen(false)}>Close</button>
          <ScriptRail steps={steps} speakers={speakers} currentIndex={currentStepIndex} selectedRole={selectedRole} onJump={(index) => { setRailOpen(false); goTo(index); }} />
        </aside>

        <section className="rehearsal-center" aria-live="polite">
          <article className="rehearsal-card">
            {cueStep && (
              <section className="cue-block">
                <span>Cue · {cueSpeaker || "Scene direction"}</span>
                <p>{cueStep.verbalLine}</p>
              </section>
            )}
            {stageDirections.map((direction, index) => <p className="rehearsal-direction" key={index}>{direction.text}</p>)}
            {selectedRole && userStep && (
              <section className="actor-line">
                <span>Your line · {displayCharacter(selectedRole)}</span>
                <p className={lineMode === "hidden" ? "is-hidden" : ""}>
                  {lineMode === "hidden" ? "Line hidden" : lineMode === "first" ? `${firstWords}…` : isMyLine ? <TrackedWords text={visibleUserLine} matchedCount={matchedWordCount} /> : visibleUserLine}
                </p>
              </section>
            )}
            <div className={`rehearsal-status is-${status.kind}`}>
              {status.kind === "listening" && <span className="mic-meter" aria-label="Microphone active"><i /><i /><i /><i /></span>}
              <div><strong>{status.title}</strong><span>{status.detail}</span></div>
            </div>
            <div className="rehearsal-controls">
              <button onClick={replayCue} disabled={!cueStep}>↻ Replay cue</button>
              <button onClick={() => setLineMode((mode) => mode === "full" ? "hidden" : "full")}>{lineMode === "hidden" ? "Show line" : "Hide line"}</button>
              <button onClick={togglePause}>{paused ? "Resume" : "Pause"}</button>
            </div>
            <footer><button onClick={goPrev} disabled={currentStepIndex === 0}>← Previous</button><span>Line {currentStepIndex + 1} of {steps.length}</span><button className="next-line" onClick={goNext} disabled={currentStepIndex >= steps.length - 1}>Next →</button></footer>
          </article>
        </section>

        <aside className={`rehearsal-settings ${settingsOpen ? "is-open" : ""}`}>
          <button className="drawer-close" onClick={() => setSettingsOpen(false)}>Close</button>
          <h2>Rehearsal controls</h2>
          <div className="autoflow-setting"><div><strong>Auto-flow: {autoAdvance ? "On" : "Off"}</strong><span>{autoAdvance ? "Advances after your line is detected." : "Use Next to advance each line."}</span></div><button role="switch" aria-checked={autoAdvance} onClick={() => setAutoAdvance((value) => !value)}><i /></button></div>
          <fieldset><legend>Line help</legend>{(["full", "first", "hidden"] as LineMode[]).map((mode) => <label key={mode}><input type="radio" name="line-mode" checked={lineMode === mode} onChange={() => setLineMode(mode)} />{mode === "full" ? "Show full line" : mode === "first" ? "Show first words" : "Hide line"}</label>)}</fieldset>
          <div className="shortcut-help"><strong>Keyboard shortcuts</strong><span>Space Pause / resume</span><span>R Replay cue</span><span>← → Previous / next</span><span>H Hide / reveal line</span></div>
        </aside>
      </div>
    </main>
  );
}

function displayCharacter(name: string) {
  return name.toLocaleLowerCase().replace(/(^|[\s'-])\p{L}/gu, (letter) => letter.toLocaleUpperCase());
}
