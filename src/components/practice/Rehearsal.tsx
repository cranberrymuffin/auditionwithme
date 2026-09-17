import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { Step } from "../../types";
import { normalizeSpeaker } from "../../lib/script";
import { deliveryTagFromContent, isPerformanceMarkup } from "../../lib/delivery";
import { useTtsPlayer, type TtsIntensity, type TtsLine } from "../../hooks/useTtsPlayer";
import { useScribeTracking } from "../../hooks/useScribeTracking";
import { useSelfTapeSession } from "../../hooks/useSelfTapeSession";
import { useWakeLock } from "../../hooks/useWakeLock";
import RehearsalLineList from "./RehearsalLineList";
import SelfTapeRecorder from "./SelfTapeRecorder";

type PlaybackState = "waiting" | "playing" | "ready" | "paused" | "error";
type LineMode = "full" | "hidden";
type StartPhase = "idle" | "preparing" | "countdown" | "active";
const COUNTDOWN_START = 3;
// iOS needs a moment to settle its shared audio session once the recorder
// engages simultaneous mic capture + audio-graph mixing — audio started too
// soon into that transition can go missing with no signal to observe
// (AudioContext.state reports "running" throughout). Delaying the very
// first cue avoids racing a transition that only happens once, at start.
const RECORDING_SETTLE_MS = 500;

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
  const navigate = useNavigate();
  const {
    user,
    status: recorderStatus,
    stream: cameraStream,
    error: recorderError,
    saving: recorderSaving,
    requestCamera,
    startRecording,
    pause: pauseRecording,
    resume: resumeRecording,
    finish: finishRecording,
  } = useSelfTapeSession(scriptId);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [playbackState, setPlaybackState] = useState<PlaybackState>("waiting");
  const [lineMode, setLineMode] = useState<LineMode>("full");
  const [startPhase, setStartPhase] = useState<StartPhase>("idle");
  const [countdown, setCountdown] = useState(COUNTDOWN_START);
  const intensity: TtsIntensity = "dramatic";
  // Refs so mid-line updates (AI delivery tags arriving) don't restart the
  // audio effect below.
  const deliveryTagsRef = useRef(deliveryTags);
  deliveryTagsRef.current = deliveryTags;
  const { play, prefetch, stop, getTapStream, unlock, getAudioContext } = useTtsPlayer();

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
  const { matchedWordCount, listening } = useScribeTracking(isMyLine && !paused && startPhase === "active", currentStep?.verbalLine ?? "", languageCode, cameraStream);

  // Nothing to record if the user isn't reading a role — just listening to
  // the scene doesn't need a camera or a self-tape.
  const willRecord = Boolean(selectedRole);

  const beginRehearsal = useCallback(() => {
    // Must run synchronously inside this click handler — the first cue plays
    // seconds later, after the countdown, well outside the user gesture that
    // autoplay policies require.
    unlock();
    if (!willRecord) {
      setCountdown(COUNTDOWN_START);
      setStartPhase("countdown");
      return;
    }
    setStartPhase("preparing");
    void requestCamera().then(() => {
      setCountdown(COUNTDOWN_START);
      setStartPhase("countdown");
    });
  }, [unlock, willRecord, requestCamera]);

  useEffect(() => {
    if (startPhase !== "countdown") return;
    if (countdown <= 0) {
      setStartPhase("active");
      return;
    }
    const timer = setTimeout(() => setCountdown((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [startPhase, countdown]);

  // Recording begins the instant the countdown overlay drops.
  const recordingStartedRef = useRef(false);
  const recordingReadyAtRef = useRef(0);
  useEffect(() => {
    if (!willRecord || startPhase !== "active" || recordingStartedRef.current) return;
    recordingStartedRef.current = true;
    startRecording(getTapStream(), getAudioContext());
    recordingReadyAtRef.current = Date.now() + RECORDING_SETTLE_MS;
  }, [willRecord, startPhase, startRecording, getTapStream, getAudioContext]);

  // Keep the script from scrolling behind the start overlay.
  useEffect(() => {
    if (startPhase === "active") return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [startPhase]);

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
    // Nothing to advance to on the last step — leave playbackState at "ready"
    // so the auto-finish check below (which watches for exactly that) fires.
    const isLast = currentStepIndex >= steps.length - 1;
    if (!step.verbalLine.trim()) {
      setPlaybackState("ready");
      if (isLast) return;
      const timer = setTimeout(() => goNextRef.current(), 1200);
      return () => clearTimeout(timer);
    }
    const line = ttsLine(currentStepIndex);
    if (!line) return;
    const controller = new AbortController();
    const startPlayback = () => {
      if (controller.signal.aborted) return;
      setFailureReason(null);
      setPlaybackState("playing");
      play(line, {
        intensity,
        signal: controller.signal,
        onFallback: (reason) => { setFailureReason(reason); setPlaybackState("error"); },
        onEnded: () => {
          setPlaybackState("ready");
          if (!isLast) goNextRef.current();
        },
      }).catch((error) => {
        if (error?.name !== "AbortError") { setFailureReason(error?.message ?? null); setPlaybackState("error"); }
      });
    };
    const settleDelay = willRecord ? Math.max(0, recordingReadyAtRef.current - Date.now()) : 0;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    if (settleDelay > 0) settleTimer = setTimeout(startPlayback, settleDelay);
    else startPlayback();
    return () => { if (settleTimer) clearTimeout(settleTimer); controller.abort(); stop(); };
  }, [currentStepIndex, steps, selectedRole, paused, startPhase, intensity, ttsLine, play, prefetch, stop, willRecord]);

  const lineDetected = isMyLine && lineWordCount > 0 && matchedWordCount >= lineWordCount;
  useEffect(() => {
    if (!lineDetected) return;
    const timer = setTimeout(() => goNextRef.current(), 800);
    return () => clearTimeout(timer);
  }, [lineDetected]);

  // Both the natural end of the script and the manual Stop button end the
  // audition the same way: save the take, then land on its tile in My
  // Scripts so the user can immediately review, download, or delete it.
  const endRehearsal = useCallback(async () => {
    // finishRecording() guards its own errors and shouldn't throw, but this
    // still can't be allowed to skip the navigate below — an unhandled
    // rejection here used to leave the rehearsal stuck on-screen with no
    // feedback prompt and no way back to My Auditions.
    const tapeId = await finishRecording().catch((err) => {
      console.error("endRehearsal: finishRecording failed unexpectedly", err);
      return null;
    });
    // Beta: a saved audition owes feedback — FeedbackGate.tsx is mounted at
    // the app root and shows its blocking overlay on top of whatever page
    // we land on next. It's notified from selfTapeUpload.ts once the
    // self_tapes row is actually confirmed saved, not from here — this
    // resolves as soon as the take is staged locally, well before that.
    navigate("/account", tapeId ? { state: { openTapeId: tapeId } } : undefined);
  }, [finishRecording, navigate]);

  // Recording stops itself automatically once the last line wraps up.
  const isLastStep = currentStepIndex === steps.length - 1;
  const lastLineFinished = isLastStep && (isMyLine ? lineDetected : playbackState === "ready");
  const [complete, setComplete] = useState(false);
  const [failureReason, setFailureReason] = useState<string | null>(null);
  const finishedRef = useRef(false);
  useEffect(() => {
    if (!willRecord || !lastLineFinished || paused || startPhase !== "active" || finishedRef.current) return;
    finishedRef.current = true;
    setComplete(true);
    setPaused(true);
    void endRehearsal();
  }, [willRecord, lastLineFinished, paused, startPhase, endRehearsal]);

  const cueIndex = isMyLine
    ? [...steps.slice(0, currentStepIndex).keys()].reverse().find((index) => steps[index].verbalLine.trim())
    : currentStepIndex;
  const cueStep = cueIndex === undefined ? null : steps[cueIndex];

  const replayCue = useCallback(() => {
    if (cueIndex === undefined) return;
    const line = ttsLine(cueIndex);
    if (!line) return;
    stop();
    setPaused(false);
    setFailureReason(null);
    setPlaybackState("playing");
    play(line, {
      intensity,
      onFallback: (reason) => { setFailureReason(reason); setPlaybackState("error"); },
      onEnded: () => setPlaybackState(isMyLine ? "ready" : "waiting"),
    }).catch((error) => { setFailureReason(error?.message ?? null); setPlaybackState("error"); });
  }, [cueIndex, ttsLine, intensity, isMyLine, play, stop]);

  const togglePause = useCallback(() => {
    setPaused((value) => {
      if (!value) { stop(); setPlaybackState("paused"); pauseRecording(); }
      else { resumeRecording(); }
      return !value;
    });
  }, [stop, pauseRecording, resumeRecording]);

  const stopRecordingManually = useCallback(() => {
    stop();
    setPaused(true);
    finishedRef.current = true;
    void endRehearsal();
  }, [stop, endRehearsal]);

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

  // Guard both an actual tab close/refresh and the in-app Exit paths below
  // while a take is in progress and not yet saved.
  const isRecordingActive = recorderStatus === "recording" || recorderStatus === "paused" || recorderSaving;
  // A phone locking its screen mid-take suspends camera/mic capture and can
  // silently lose the recording — keep the screen awake while one's active.
  useWakeLock(isRecordingActive);
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!isRecordingActive) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isRecordingActive]);

  const confirmExit = useCallback(() => {
    if (!isRecordingActive) return true;
    return window.confirm("You have unsaved changes. Are you sure you want to leave?");
  }, [isRecordingActive]);

  if (!currentStep) return null;
  const progress = ((currentStepIndex + 1) / steps.length) * 100;
  const status = complete
    ? { title: "Rehearsal complete", detail: "Saving your take…", kind: "complete" }
    : paused
      ? { title: "Rehearsal paused", detail: "Resume when you’re ready.", kind: "paused" }
      : playbackState === "error"
        ? { title: "Cue playback failed", detail: failureReason ?? "Replay the cue or continue manually.", kind: "error" }
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
          <button
            onClick={() => { if (confirmExit()) onBack(); }}
            aria-label="Back to role and voice setup"
            title="Back to setup"
          >
            ←
          </button>
          <span title={fileName}>{fileName}</span>
        </div>
        <p><strong>Rehearsal</strong><span>Line {currentStepIndex + 1} of {steps.length}</span></p>
        <div>
          <Link to="/" onClick={(event) => { if (!confirmExit()) event.preventDefault(); }}>Exit</Link>
        </div>
      </header>
      <div className="rehearsal-progress"><i style={{ width: `${progress}%` }} /></div>

      <div className="rehearsal-workspace">
        {willRecord && startPhase !== "idle" && scriptId && (
          <SelfTapeRecorder
            status={recorderStatus}
            stream={cameraStream}
            error={recorderError}
            saving={recorderSaving}
            paused={paused}
            onTogglePause={togglePause}
            onStop={stopRecordingManually}
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
            canReplay={Boolean(cueStep)}
            onJump={goTo}
            onPrev={goPrev}
            onNext={goNext}
            onReplay={replayCue}
            onStop={stopRecordingManually}
          />
        </section>

        {startPhase !== "active" && (
          <div className="rehearsal-start-overlay">
            {startPhase === "idle" && (
              <div className="rehearsal-start-choice">
                <h2>Ready to rehearse?</h2>
                <p>
                  {willRecord
                    ? "We'll record a self-tape while you run the scene."
                    : "Sit back and listen to the full scene."}
                </p>
                <div>
                  <button
                    type="button"
                    onClick={beginRehearsal}
                    disabled={willRecord && (!scriptId || !user)}
                  >
                    Start
                  </button>
                </div>
                {willRecord && !user && <span>Sign in to rehearse.</span>}
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
