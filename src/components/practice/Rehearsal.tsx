import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { Step } from "../../types";
import { normalizeSpeaker } from "../../lib/script";
import { buildReaderCue, type ReaderCue } from "../../lib/readerLines";
import { useTtsPlayer, type TtsIntensity, type TtsLine } from "../../hooks/useTtsPlayer";
import { useScribeTracking } from "../../hooks/useScribeTracking";
import { useSelfTapeSession } from "../../hooks/useSelfTapeSession";
import { useWakeLock } from "../../hooks/useWakeLock";
import { TakeMetrics } from "../../lib/takeMetrics";
import type { ReaderAudioPregen } from "../../hooks/useReaderAudioPregen";
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
// If the opening lines still aren't pre-generated after this long (a busy
// account, a slow network), offer to start anyway — those lines then fetch
// live during the take instead of keeping the actor waiting here. Only for
// paths that skip VoiceCasting, which otherwise does this wait itself.
const START_ANYWAY_AFTER_MS = 20_000;

export default function Rehearsal({ steps, selectedRole, characterVoices, characterVolumes, deliveryTags, onBack, languageCode, fileName, scriptId, pregen, awaitPregen, onRecordingActiveChange }: {
  steps: Step[];
  selectedRole: string;
  characterVoices: Record<string, string>;
  /** Speaker → level set on the voice setup screen (missing = unity). */
  characterVolumes: Record<string, number>;
  deliveryTags: (string | null)[];
  onBack: () => void;
  /** Whether a take is recording or saving, for guards outside (browser
   * Back) that confirmExit can't reach. */
  onRecordingActiveChange?: (active: boolean) => void;
  languageCode: string;
  fileName: string;
  scriptId: string | null;
  /** Reader-audio pre-generation (useReaderAudioPregen), run by Practice
   * from VoiceCasting's "Start rehearsal" on, and through the take. */
  pregen: ReaderAudioPregen;
  /** Gate Start on pre-generation here — only when VoiceCasting was skipped
   * (monologues, "Practice as X"); otherwise it already waited there. */
  awaitPregen: boolean;
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
  } = useSelfTapeSession(scriptId, selectedRole);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [playbackState, setPlaybackState] = useState<PlaybackState>("waiting");
  const [lineMode, setLineMode] = useState<LineMode>("full");
  const [startPhase, setStartPhase] = useState<StartPhase>("idle");
  const [countdown, setCountdown] = useState(COUNTDOWN_START);
  // Pinned: emotion comes from the director's per-line audio tags, not a
  // global intensity knob ("dramatic" read every tagged line over the top).
  const intensity: TtsIntensity = "natural";
  // Refs so mid-line updates (AI delivery tags arriving) don't restart the
  // audio effect below.
  const deliveryTagsRef = useRef(deliveryTags);
  deliveryTagsRef.current = deliveryTags;
  // Lines fetched live are stored under this script for next time; during a
  // take each one (pre-generation hadn't got there) is counted in telemetry.
  const startPhaseRef = useRef(startPhase);
  startPhaseRef.current = startPhase;
  const { play, prefetch, stop, getTapStream, unlock, getAudioContext } = useTtsPlayer({
    scriptId,
    onLiveFetch: () => {
      if (startPhaseRef.current === "active") takeMetricsRef.current.recordLiveFetch();
    },
  });

  // Same builder pre-generation uses (lib/readerLines.ts), so the request —
  // and its cache key — match what was generated before Start. The cue also
  // carries the line's intentional beat, held before it plays.
  const readerCue = useCallback(
    (index: number): ReaderCue | null => buildReaderCue(steps, index, characterVoices, deliveryTagsRef.current),
    [steps, characterVoices],
  );
  // Fixed for the take: set on the voice setup screen, never mid-scene.
  const volumeFor = useCallback(
    (index: number) => characterVolumes[normalizeSpeaker(steps[index]?.speaker ?? "")],
    [steps, characterVolumes],
  );
  const ttsLine = useCallback((index: number): TtsLine | null => readerCue(index)?.line ?? null, [readerCue]);

  const currentStep = steps[currentStepIndex];
  const currentSpeaker = normalizeSpeaker(currentStep?.speaker ?? "");
  const isMyLine = Boolean(selectedRole) && currentSpeaker === selectedRole;
  const lineWordCount = (currentStep?.verbalLine ?? "").split(/\s+/).filter(Boolean).length;
  // Started as soon as the countdown begins, not when it hits zero — the
  // Scribe connection (token fetch + WebSocket handshake) can take longer
  // than a short opening line, so if it only spun up at "active" the actor
  // could start speaking before the mic was actually being transcribed.
  const scribeWarm = startPhase === "countdown" || startPhase === "active";
  const { matchedWordCount, listening, lineCompletionRef } = useScribeTracking(isMyLine && !paused && scribeWarm, currentStep?.verbalLine ?? "", languageCode, cameraStream);

  // Nothing to record if the user isn't reading a role — just listening to
  // the scene doesn't need a camera or a self-tape.
  const willRecord = Boolean(selectedRole);

  // This take's telemetry (lib/takeMetrics.ts), saved with the recording and
  // sent along with its feedback. Fresh per Start.
  const takeMetricsRef = useRef(new TakeMetrics());

  // Tells pre-generation where the actor is, so it works on upcoming lines
  // first and drops to one worker once the take is under way.
  const { setPlayhead } = pregen;
  useEffect(() => {
    setPlayhead(currentStepIndex, startPhase !== "idle");
  }, [setPlayhead, currentStepIndex, startPhase]);
  const pregenRef = useRef(pregen);
  pregenRef.current = pregen;
  const [startAnywayOffered, setStartAnywayOffered] = useState(false);
  useEffect(() => {
    if (!awaitPregen || pregen.canStart || startAnywayOffered) return;
    const timer = setTimeout(() => setStartAnywayOffered(true), START_ANYWAY_AFTER_MS);
    return () => clearTimeout(timer);
  }, [awaitPregen, pregen.canStart, startAnywayOffered]);
  const pregenReady = !awaitPregen || pregen.canStart;
  const canStart = pregenReady || startAnywayOffered || pregen.failed > 0;

  const beginRehearsal = useCallback(() => {
    takeMetricsRef.current = new TakeMetrics();
    takeMetricsRef.current.liveFetchesDuringTake = 0;
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
  // Counts how each of the actor's lines moved on — detected (with the
  // moment it was, opening a reader-latency sample) or by hand — once per
  // visit to the line.
  const lineAdvanceRecordedRef = useRef(false);
  useEffect(() => {
    lineAdvanceRecordedRef.current = false;
  }, [currentStepIndex]);
  const recordMyLineAdvance = useCallback(() => {
    if (!isMyLine || startPhase !== "active" || lineAdvanceRecordedRef.current) return;
    lineAdvanceRecordedRef.current = true;
    const completion = lineCompletionRef.current;
    if (completion) takeMetricsRef.current.recordLineCompleted(completion.kind, completion.at);
    else takeMetricsRef.current.recordManualNext();
  }, [isMyLine, startPhase, lineCompletionRef]);
  const goNext = useCallback(() => {
    recordMyLineAdvance();
    goTo(currentStepIndex + 1);
  }, [recordMyLineAdvance, goTo, currentStepIndex]);
  const goPrev = useCallback(() => {
    if (startPhase === "active") takeMetricsRef.current.recordPrevious(Date.now());
    goTo(currentStepIndex - 1);
  }, [startPhase, goTo, currentStepIndex]);
  const goNextRef = useRef(goNext);
  goNextRef.current = goNext;

  useEffect(() => {
    // Taken (and cleared) on every run, so a latency sample only pairs the
    // actor's line with the step right after it, and never spans a pause.
    const lineCompletedAt = takeMetricsRef.current.takePendingAdvance();
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
    const cue = readerCue(currentStepIndex);
    if (!cue) return;
    const { line, beatMs } = cue;
    const controller = new AbortController();
    let latencyRecorded = false;
    const onPlaying = lineCompletedAt === null ? undefined : () => {
      // 'playing' fires again after a mid-line stall; only the first counts.
      if (latencyRecorded) return;
      latencyRecorded = true;
      // The intentional beat is subtracted, not the sample skipped: what's
      // left is still the app's own response time on beat lines.
      takeMetricsRef.current.recordReaderLatency(Math.max(0, Date.now() - lineCompletedAt - beatMs));
    };
    const startPlayback = () => {
      if (controller.signal.aborted) return;
      setFailureReason(null);
      setPlaybackState("playing");
      play(line, {
        intensity,
        volume: volumeFor(currentStepIndex),
        signal: controller.signal,
        onPlaying,
        onFallback: (reason) => { setFailureReason(reason); setPlaybackState("error"); },
        onEnded: () => {
          setPlaybackState("ready");
          if (!isLast) goNextRef.current();
        },
      }).catch((error) => {
        if (error?.name !== "AbortError") { setFailureReason(error?.message ?? null); setPlaybackState("error"); }
      });
    };
    // The recording settle and the line's beat both just hold silence before
    // the cue, so they overlap (max, not sum). Pause/jump/stop re-run this
    // effect, whose cleanup cancels the hold.
    const settleDelay = willRecord ? Math.max(0, recordingReadyAtRef.current - Date.now()) : 0;
    const holdMs = Math.max(settleDelay, beatMs);
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    if (holdMs > 0) {
      // Fetch during the beat (a no-op when pre-generated), so it isn't
      // followed by a load wait.
      prefetch(line, intensity);
      holdTimer = setTimeout(startPlayback, holdMs);
    } else startPlayback();
    return () => { if (holdTimer) clearTimeout(holdTimer); controller.abort(); stop(); };
  }, [currentStepIndex, steps, selectedRole, paused, startPhase, intensity, ttsLine, readerCue, volumeFor, play, prefetch, stop, willRecord]);

  const lineDetected = isMyLine && lineWordCount > 0 && matchedWordCount >= lineWordCount;
  useEffect(() => {
    if (!lineDetected) return;
    // Just long enough to ride out Scribe rewriting a partial transcript;
    // anything more is dead air before the reader answers. Only reached once
    // the line's ending has been heard (or after the long patient hold, see
    // lib/lineMatch.ts), so it can be short.
    const timer = setTimeout(() => goNextRef.current(), 300);
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
    // Pre-generation's duration (to its finish, or to now if it's still
    // going) and how many lines it gave up on.
    const { startedAt, finishedAt, failed } = pregenRef.current;
    const metrics = takeMetricsRef.current;
    metrics.pregenMs = startedAt === null ? null : (finishedAt ?? Date.now()) - startedAt;
    metrics.pregenFailedLines = startedAt === null ? null : failed;
    const tapeId = await finishRecording(metrics).catch((err) => {
      console.error("endRehearsal: finishRecording failed unexpectedly", err);
      return null;
    });
    // Beta: a saved audition owes feedback — FeedbackGate.tsx is mounted at
    // the app root and shows its blocking overlay on top of whatever page we
    // land on next. It's notified from inside finishRecording() itself (see
    // useSelfTapeSession.ts) once the take is actually saved.
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
    recordMyLineAdvance();
    setComplete(true);
    setPaused(true);
    void endRehearsal();
  }, [willRecord, lastLineFinished, paused, startPhase, endRehearsal, recordMyLineAdvance]);

  const cueIndex = isMyLine
    ? [...steps.slice(0, currentStepIndex).keys()].reverse().find((index) => steps[index].verbalLine.trim())
    : currentStepIndex;
  const cueStep = cueIndex === undefined ? null : steps[cueIndex];

  // Plays at once, with no beat: the actor asked for the cue, so a beat
  // would only read as lag.
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
      volume: volumeFor(cueIndex),
      onFallback: (reason) => { setFailureReason(reason); setPlaybackState("error"); },
      onEnded: () => setPlaybackState(isMyLine ? "ready" : "waiting"),
    }).catch((error) => { setFailureReason(error?.message ?? null); setPlaybackState("error"); });
  }, [cueIndex, ttsLine, volumeFor, intensity, isMyLine, play, stop]);

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

  const onRecordingActiveChangeRef = useRef(onRecordingActiveChange);
  onRecordingActiveChangeRef.current = onRecordingActiveChange;
  useEffect(() => {
    onRecordingActiveChangeRef.current?.(isRecordingActive);
    return () => onRecordingActiveChangeRef.current?.(false);
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
      <h1 className="sr-only">Rehearsal: {fileName}</h1>
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
                {awaitPregen && (pregen.waitingForDirection || (!pregen.done && pregen.total > 0)) && (
                  <div className="rehearsal-pregen" role="status">
                    <span>
                      {pregen.waitingForDirection
                        ? "Directing your scene partner…"
                        : `Preparing your scene partner’s lines · ${pregen.ready} of ${pregen.total}`}
                    </span>
                    <i aria-hidden="true">
                      <b style={{ width: `${pregen.total ? (pregen.ready / pregen.total) * 100 : 0}%` }} />
                    </i>
                  </div>
                )}
                <div>
                  <button
                    type="button"
                    onClick={beginRehearsal}
                    disabled={(willRecord && (!scriptId || !user)) || !canStart}
                  >
                    {pregenReady || !canStart ? "Start" : "Start anyway"}
                  </button>
                </div>
                {awaitPregen && pregen.failed > 0 && (
                  <span>Some lines couldn’t be pre-loaded; they’ll load as you go.</span>
                )}
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
