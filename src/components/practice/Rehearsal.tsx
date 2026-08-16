import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { Step } from "../../types";
import { normalizeSpeaker } from "../../lib/script";
import { deliveryTagFromContent, isPerformanceMarkup } from "../../lib/delivery";
import { useTtsPlayer, type TtsIntensity, type TtsLine } from "../../hooks/useTtsPlayer";
import { useScribeTracking } from "../../hooks/useScribeTracking";
import RehearsalLineList from "./RehearsalLineList";

type PlaybackState = "waiting" | "playing" | "ready" | "paused" | "error";
type LineMode = "full" | "first" | "hidden";

export default function Rehearsal({ steps, selectedRole, characterVoices, deliveryTags, onBack, languageCode, fileName }: {
  steps: Step[];
  selectedRole: string;
  characterVoices: Record<string, string>;
  deliveryTags: (string | null)[];
  onBack: () => void;
  languageCode: string;
  fileName: string;
}) {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [autoAdvance, setAutoAdvance] = useState(true);
  const [paused, setPaused] = useState(false);
  const [playbackState, setPlaybackState] = useState<PlaybackState>("waiting");
  const [lineMode, setLineMode] = useState<LineMode>("full");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const intensity: TtsIntensity = "dramatic";
  const [voiceSpeed, setVoiceSpeed] = useState(1);
  const autoAdvanceRef = useRef(autoAdvance);
  autoAdvanceRef.current = autoAdvance;
  // Refs so mid-line updates (AI delivery tags arriving, slider drags) don't
  // restart the audio effect below.
  const deliveryTagsRef = useRef(deliveryTags);
  deliveryTagsRef.current = deliveryTags;
  const voiceSpeedRef = useRef(voiceSpeed);
  const { play, prefetch, stop, setPlaybackRate } = useTtsPlayer();

  useEffect(() => {
    voiceSpeedRef.current = voiceSpeed;
    setPlaybackRate(voiceSpeed);
  }, [voiceSpeed, setPlaybackRate]);

  // Builds the full synthesis request for a step: surrounding lines condition
  // the prosody, and an explicit script parenthetical outranks the AI
  // director's inferred tag.
  const ttsLine = useCallback((index: number): TtsLine | null => {
    const step = steps[index];
    if (!step?.verbalLine.trim()) return null;
    const before = [...steps.slice(0, index)].reverse().find((item) => item.verbalLine.trim());
    const after = steps.slice(index + 1).find((item) => item.verbalLine.trim());
    // Explicit script parenthetical outranks the AI director. Director entries
    // are performance markup of the whole line on newly directed scripts, or a
    // legacy single-word tag on scripts saved before the markup upgrade.
    const parenthetical = deliveryTagFromContent(step.content);
    const directed = parenthetical ? null : deliveryTagsRef.current[index];
    const performance = directed && isPerformanceMarkup(directed, step.verbalLine) ? directed : undefined;
    return {
      text: step.verbalLine,
      voiceId: characterVoices[normalizeSpeaker(step.speaker)],
      previousText: before?.verbalLine,
      nextText: after?.verbalLine,
      deliveryTag: parenthetical ?? (performance ? undefined : directed ?? undefined),
      performance,
    };
  }, [steps, characterVoices]);

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
    const nextIndex = steps.findIndex((item, index) => index > currentStepIndex && item.verbalLine.trim() && (!selectedRole || normalizeSpeaker(item.speaker) !== selectedRole));
    if (nextIndex !== -1) {
      const nextLine = ttsLine(nextIndex);
      if (nextLine) prefetch(nextLine, intensity);
    }
    if (!step.verbalLine.trim()) {
      setPlaybackState("ready");
      const timer = setTimeout(() => { if (autoAdvanceRef.current) goNextRef.current(); }, 1200);
      return () => clearTimeout(timer);
    }
    const line = ttsLine(currentStepIndex);
    if (!line) return;
    const controller = new AbortController();
    setPlaybackState("playing");
    play(line, {
      intensity,
      speed: voiceSpeedRef.current,
      signal: controller.signal,
      onEnded: () => {
        setPlaybackState("ready");
        if (autoAdvanceRef.current) goNextRef.current();
      },
    }).catch((error) => {
      if (error?.name !== "AbortError") setPlaybackState("error");
    });
    return () => { controller.abort(); stop(); };
  }, [currentStepIndex, steps, selectedRole, paused, intensity, ttsLine, play, prefetch, stop]);

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

  // fresh=true busts the audio cache — "give me a different take" on the cue.
  const replayCue = useCallback((fresh = false) => {
    if (cueIndex === undefined) return;
    const line = ttsLine(cueIndex);
    if (!line) return;
    stop();
    setPaused(false);
    setPlaybackState("playing");
    play(line, {
      intensity,
      speed: voiceSpeedRef.current,
      fresh,
      onEnded: () => setPlaybackState(isMyLine ? "ready" : "waiting"),
    }).catch(() => setPlaybackState("error"));
  }, [cueIndex, ttsLine, intensity, isMyLine, play, stop]);

  const togglePause = useCallback(() => {
    setPaused((value) => {
      if (!value) { stop(); setPlaybackState("paused"); }
      return !value;
    });
  }, [stop]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSettingsOpen(false);
        return;
      }
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

  return (
    <main className="rehearsal-page">
      <header className="rehearsal-header">
        <div className="rehearsal-context">
          <button onClick={onBack} aria-label="Back to role and voice setup" title="Back to setup">←</button>
          <span title={fileName}>{fileName}</span>
        </div>
        <p><strong>Rehearsal</strong><span>Line {currentStepIndex + 1} of {steps.length}</span></p>
        <div><button className="controls-toggle" onClick={() => setSettingsOpen((open) => !open)} aria-expanded={settingsOpen}>Controls</button><Link to="/">Exit</Link></div>
      </header>
      <div className="rehearsal-progress"><i style={{ width: `${progress}%` }} /></div>

      <div className="rehearsal-workspace">
        {settingsOpen && (
          <button
            type="button"
            className="drawer-scrim"
            aria-label="Close panel"
            onClick={() => setSettingsOpen(false)}
          />
        )}
        <section className="rehearsal-center" aria-live="polite">
          <RehearsalLineList
            steps={steps}
            currentIndex={currentStepIndex}
            selectedRole={selectedRole}
            lineMode={lineMode}
            isMyLine={isMyLine}
            matchedWordCount={matchedWordCount}
            status={status}
            paused={paused}
            canReplay={Boolean(cueStep)}
            onJump={goTo}
            onPrev={goPrev}
            onNext={goNext}
            onReplay={() => replayCue()}
            onNewTake={() => replayCue(true)}
            onToggleHide={() => setLineMode((mode) => mode === "full" ? "hidden" : "full")}
            onTogglePause={togglePause}
          />
        </section>

        <aside className={`rehearsal-settings ${settingsOpen ? "is-open" : ""}`}>
          <button className="drawer-close" onClick={() => setSettingsOpen(false)}>Close</button>
          <h2>Rehearsal controls</h2>
          <div className="autoflow-setting"><div><strong>Auto-flow: {autoAdvance ? "On" : "Off"}</strong><span>{autoAdvance ? "Advances after your line is detected." : "Use Next to advance each line."}</span></div><button role="switch" aria-checked={autoAdvance} onClick={() => setAutoAdvance((value) => !value)}><i /></button></div>
          <fieldset><legend>Line help</legend>{(["full", "first", "hidden"] as LineMode[]).map((mode) => <label key={mode}><input type="radio" name="line-mode" checked={lineMode === mode} onChange={() => setLineMode(mode)} />{mode === "full" ? "Show full line" : mode === "first" ? "Show first words" : "Hide line"}</label>)}</fieldset>
          <div className="voice-speed-setting">
            <label htmlFor="voice-speed"><strong>Voice speed: {voiceSpeed.toFixed(2)}×</strong></label>
            {/* Implemented as client-side time-stretch (Eleven v3 has no API
                speed setting), which audibly degrades below ~0.9× — pacing
                should come from the director's markup, not this slider. */}
            <input id="voice-speed" type="range" min={0.9} max={1.1} step={0.05} value={voiceSpeed} onChange={(event) => setVoiceSpeed(Number(event.target.value))} />
          </div>
          <div className="shortcut-help"><strong>Keyboard shortcuts</strong><span>Space Pause / resume</span><span>R Replay cue</span><span>← → Previous / next</span><span>H Hide / reveal line</span></div>
        </aside>
      </div>
    </main>
  );
}
