import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { Step } from "../../types";
import { normalizeSpeaker } from "../../lib/script";
import { deliveryTagFromContent, isPerformanceMarkup } from "../../lib/delivery";
import { useAuth } from "../../contexts/AuthContext";
import { useTtsPlayer, type TtsIntensity, type TtsLine } from "../../hooks/useTtsPlayer";
import { useScribeTracking } from "../../hooks/useScribeTracking";
import RehearsalLineList from "./RehearsalLineList";
import SelfTapeRecorder from "./SelfTapeRecorder";

type PlaybackState = "waiting" | "playing" | "ready" | "paused" | "error";
type LineMode = "full" | "hidden";
type StartPhase = "choose" | "preparing" | "countdown" | "active";
const COUNTDOWN_START = 3;

export default function Rehearsal({ steps, selectedRole, characterVoices, deliveryTags, onBack, languageCode, fileName, scriptId }: {
  steps: Step[];
  selectedRole: string;
  characterVoices: Record<string, string>;
  deliveryTags: (string | null)[];
  onBack: () => void;
  languageCode: string;
  fileName: string;
  scriptId: string | null;
}) {
  const { user } = useAuth();
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [playbackState, setPlaybackState] = useState<PlaybackState>("waiting");
  const [lineMode, setLineMode] = useState<LineMode>("full");
  const [startPhase, setStartPhase] = useState<StartPhase>("choose");
  const [selfTapeMode, setSelfTapeMode] = useState(false);
  const [countdown, setCountdown] = useState(COUNTDOWN_START);
  const intensity: TtsIntensity = "dramatic";
  // Refs so mid-line updates (AI delivery tags arriving) don't restart the
  // audio effect below.
  const deliveryTagsRef = useRef(deliveryTags);
  deliveryTagsRef.current = deliveryTags;
  const { play, prefetch, stop, getTapStream } = useTtsPlayer();

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
  const { matchedWordCount, listening } = useScribeTracking(isMyLine && !paused && startPhase === "active", currentStep?.verbalLine ?? "", languageCode);

  const beginRehearsal = useCallback((selfTape: boolean) => {
    setSelfTapeMode(selfTape);
    if (selfTape) {
      setStartPhase("preparing");
    } else {
      setCountdown(COUNTDOWN_START);
      setStartPhase("countdown");
    }
  }, []);

  // The camera must be live before the countdown overlay drops, so self-tape
  // mode waits here for the recorder to report readiness before counting down.
  const handleCameraReady = useCallback(() => {
    setCountdown(COUNTDOWN_START);
    setStartPhase("countdown");
  }, []);

  useEffect(() => {
    if (startPhase !== "countdown") return;
    if (countdown <= 0) {
      setStartPhase("active");
      return;
    }
    const timer = setTimeout(() => setCountdown((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [startPhase, countdown]);

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
    if (paused || startPhase !== "active") return;
    const step = steps[currentStepIndex];
    if (!step) return;
    const speaker = normalizeSpeaker(step.speaker);
    // Prefetch the next opposing-character line regardless of whose turn this
    // step is, so audio is already warm by the time the user finishes their
    // own line and playback advances to it.
    const nextIndex = steps.findIndex((item, index) => index > currentStepIndex && item.verbalLine.trim() && (!selectedRole || normalizeSpeaker(item.speaker) !== selectedRole));
    if (nextIndex !== -1) {
      const nextLine = ttsLine(nextIndex);
      if (nextLine) prefetch(nextLine, intensity);
    }
    if (selectedRole && speaker === selectedRole) {
      setPlaybackState("ready");
      return;
    }
    if (!step.verbalLine.trim()) {
      setPlaybackState("ready");
      const timer = setTimeout(() => goNextRef.current(), 1200);
      return () => clearTimeout(timer);
    }
    const line = ttsLine(currentStepIndex);
    if (!line) return;
    const controller = new AbortController();
    setPlaybackState("playing");
    play(line, {
      intensity,
      signal: controller.signal,
      onEnded: () => {
        setPlaybackState("ready");
        goNextRef.current();
      },
    }).catch((error) => {
      if (error?.name !== "AbortError") setPlaybackState("error");
    });
    return () => { controller.abort(); stop(); };
  }, [currentStepIndex, steps, selectedRole, paused, startPhase, intensity, ttsLine, play, prefetch, stop]);

  const lineDetected = isMyLine && lineWordCount > 0 && matchedWordCount >= lineWordCount;
  useEffect(() => {
    if (!lineDetected) return;
    const timer = setTimeout(() => goNextRef.current(), 800);
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
      if (startPhase !== "active") return;
      if ((event.target as HTMLElement)?.matches("input, select, textarea, button")) return;
      if (event.key === "ArrowRight") goNext();
      if (event.key === "ArrowLeft") goPrev();
      if (event.key.toLowerCase() === "r") replayCue();
      if (event.key.toLowerCase() === "h") setLineMode((mode) => mode === "hidden" ? "full" : "hidden");
      if (event.code === "Space") { event.preventDefault(); togglePause(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [startPhase, goNext, goPrev, replayCue, togglePause]);

  if (!currentStep) return null;
  const progress = ((currentStepIndex + 1) / steps.length) * 100;
  const status = paused
    ? { title: "Rehearsal paused", detail: "Resume when you’re ready.", kind: "paused" }
    : playbackState === "error"
      ? { title: "Cue playback failed", detail: "Replay the cue or continue manually.", kind: "error" }
      : lineDetected
        ? { title: "Got it", detail: "The next cue will play automatically.", kind: "detected" }
        : isMyLine && listening
          ? { title: "Listening for your line…", detail: "The next cue will play after your line is detected.", kind: "listening" }
          : isMyLine
            ? { title: "Your line", detail: "Microphone unavailable. Read aloud, then continue.", kind: "ready" }
            : playbackState === "playing"
              ? { title: `${currentSpeaker || "Scene partner"} is speaking…`, detail: "Listen for your cue.", kind: "playing" }
              : { title: "Cue complete", detail: "Moving to the next line.", kind: "ready" };

  return (
    <main className="rehearsal-page">
      <header className="rehearsal-header">
        <div className="rehearsal-context">
          <button onClick={onBack} aria-label="Back to role and voice setup" title="Back to setup">←</button>
          <span title={fileName}>{fileName}</span>
        </div>
        <p><strong>Rehearsal</strong><span>Line {currentStepIndex + 1} of {steps.length}</span></p>
        <div><Link to="/">Exit</Link></div>
      </header>
      <div className="rehearsal-progress"><i style={{ width: `${progress}%` }} /></div>

      <div className="rehearsal-workspace">
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

        {selfTapeMode && startPhase !== "choose" && scriptId && (
          <SelfTapeRecorder scriptId={scriptId} getTtsStream={getTapStream} autoStart onReady={handleCameraReady} />
        )}

        {startPhase !== "active" && (
          <div className="rehearsal-start-overlay">
            {startPhase === "choose" && (
              <div className="rehearsal-start-choice">
                <h2>Ready to rehearse?</h2>
                <p>Choose how you want to run this scene.</p>
                <div>
                  <button type="button" onClick={() => beginRehearsal(false)}>Practice</button>
                  <button type="button" onClick={() => beginRehearsal(true)} disabled={!scriptId || !user}>Self-tape</button>
                </div>
                {!user && <span>Sign in to record a self-tape.</span>}
              </div>
            )}
            {startPhase === "preparing" && (
              <div className="rehearsal-start-choice">
                <h2>Setting up your camera…</h2>
                <p>Allow camera and microphone access to continue.</p>
              </div>
            )}
            {startPhase === "countdown" && (
              <div className="rehearsal-countdown" key={countdown}>{countdown}</div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
