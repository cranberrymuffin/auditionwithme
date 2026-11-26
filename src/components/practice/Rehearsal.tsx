import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { Step } from "../../types";
import { displayCharacterName, normalizeSpeaker } from "../../lib/script";
import { buildReaderCue, type ReaderCue } from "../../lib/readerLines";
import { clampCharacterPace } from "../../lib/characterDelivery";
import { useTtsPlayer, type TtsIntensity, type TtsLine } from "../../hooks/useTtsPlayer";
import { useScribeTracking } from "../../hooks/useScribeTracking";
import { useSelfTapeSession } from "../../hooks/useSelfTapeSession";
import { useWakeLock } from "../../hooks/useWakeLock";
import { TakeMetrics } from "../../lib/takeMetrics";
import type { ReaderAudioPregen } from "../../hooks/useReaderAudioPregen";
import { useFeedbackOwed } from "../../hooks/useFeedbackOwed";
import { requestFeedbackGate } from "../../lib/feedbackGate";
import RehearsalLineList from "./RehearsalLineList";
import RehearsalStatusStrip, { type RehearsalStatus } from "./RehearsalStatusStrip";
import RehearsalControlBar from "./RehearsalControlBar";
import SelfTapeRecorder from "./SelfTapeRecorder";
import Modal from "../Modal";
import RehearsalSetup from "./RehearsalSetup";

type PlaybackState = "waiting" | "playing" | "ready" | "paused" | "error";
type LineMode = "full" | "hidden";
// idle: step 4 (RehearsalSetup), the camera and lines getting ready.
type StartPhase = "idle" | "countdown" | "active";
const COUNTDOWN_START = 3;
// iOS needs a moment to settle its shared audio session once the recorder
// engages simultaneous mic capture + audio-graph mixing — audio started too
// soon into that transition can go missing with no signal to observe
// (AudioContext.state reports "running" throughout). Delaying the very
// first cue avoids racing a transition that only happens once, at start.
const RECORDING_SETTLE_MS = 500;
// How long a step with nothing to say (a stage direction) stays up before
// the scene moves on by itself.
const SILENT_STEP_HOLD_MS = 1200;
// The actor's line with no new word recognised for this long: say how to
// carry on, in case the mic or the match has lost them.
const STALLED_LINE_HINT_MS = 8000;
// Line tracking reconnects at the top of each of the actor's lines; only
// call the mic missing once it's had time to.
const MIC_MISSING_AFTER_MS = 2500;

/** True once `active` has held for `ms` under the same `key`. */
function useElapsed(key: string, ms: number, active: boolean): boolean {
  const [firedKey, setFiredKey] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setFiredKey(key), ms);
    return () => clearTimeout(timer);
  }, [key, ms, active]);
  return active && firedKey === key;
}

export default function Rehearsal({ steps, selectedRole, characterVoices, characterVolumes, characterEmotions, characterPaces, coachTakes, deliveryTags, onBack, onGoToStep, languageCode, fileName, scriptId, scriptSaved, pregen, onRecordingActiveChange }: {
  steps: Step[];
  selectedRole: string;
  characterVoices: Record<string, string>;
  /** Speaker → level set on the voice setup screen (missing = unity). */
  characterVolumes: Record<string, number>;
  /** Speaker → emotion and pace set beside volume (lib/characterDelivery.ts). */
  characterEmotions: Record<string, number>;
  characterPaces: Record<string, number>;
  /** Step index → the actor's coached take of that line (coachTakeStore.ts). */
  coachTakes: Record<number, string>;
  deliveryTags: (string | null)[];
  onBack: () => void;
  /** Back to an earlier setup step (1-based), from step 4's step bars. */
  onGoToStep?: (step: number) => void;
  /** Whether a take is recording or saving, for guards outside (browser
   * Back) that confirmExit can't reach. */
  onRecordingActiveChange?: (active: boolean) => void;
  languageCode: string;
  fileName: string;
  scriptId: string;
  /** The script's saved row exists, so a take can be kept with it. */
  scriptSaved: boolean;
  /** Reader-audio pre-generation (useReaderAudioPregen), run by Practice
   * from step 4 on, and through the take. */
  pregen: ReaderAudioPregen;
}) {
  const navigate = useNavigate();
  const {
    user,
    status: recorderStatus,
    stream: cameraStream,
    error: recorderError,
    cameraInterrupted,
    zoom: cameraZoom,
    setZoom: setCameraZoom,
    saving: recorderSaving,
    requestCamera,
    switchDevice,
    startRecording,
    pause: pauseRecording,
    resume: resumeRecording,
    finish: finishRecording,
    nativePreview,
    endedInBackground,
  } = useSelfTapeSession(scriptSaved ? scriptId : null, selectedRole);
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
    (index: number): ReaderCue | null =>
      buildReaderCue(steps, index, characterVoices, deliveryTagsRef.current, characterEmotions, coachTakes, languageCode),
    [steps, characterVoices, characterEmotions, coachTakes, languageCode],
  );
  // Fixed for the take: set on the voice setup screen, never mid-scene.
  const volumeFor = useCallback(
    (index: number) => characterVolumes[normalizeSpeaker(steps[index]?.speaker ?? "")],
    [steps, characterVolumes],
  );
  const paceFor = useCallback(
    (index: number) => clampCharacterPace(characterPaces[normalizeSpeaker(steps[index]?.speaker ?? "")]),
    [steps, characterPaces],
  );
  const ttsLine = useCallback((index: number): TtsLine | null => readerCue(index)?.line ?? null, [readerCue]);
  // Read through a ref by the playback effect below, which must only restart
  // for a new step, a pause or the start: a cast map changing identity
  // mid-line (a voice, level or coached take saved elsewhere) would otherwise
  // cut the playing line off and start it again.
  const castRef = useRef({ readerCue, volumeFor, paceFor });
  castRef.current = { readerCue, volumeFor, paceFor };

  const currentStep = steps[currentStepIndex];
  const currentSpeaker = normalizeSpeaker(currentStep?.speaker ?? "");
  const isMyLine = Boolean(selectedRole) && currentSpeaker === selectedRole;
  const lineWordCount = (currentStep?.verbalLine ?? "").split(/\s+/).filter(Boolean).length;
  // Started as soon as the countdown begins, not when it hits zero — the
  // Scribe connection (token fetch + WebSocket handshake) can take longer
  // than a short opening line, so if it only spun up at "active" the actor
  // could start speaking before the mic was actually being transcribed.
  const scribeWarm = startPhase === "countdown" || startPhase === "active";
  // The mic line tracking listens to: the recorder's stream on the web; in
  // the iOS app, the native mic, live while the recorder holds the camera.
  const nativeMicOn = recorderStatus === "ready" || recorderStatus === "recording" || recorderStatus === "paused";
  const trackingMic = nativePreview ? (nativeMicOn ? "native" : null) : cameraStream;
  const { matchedWordCount, listening, lineCompletionRef } = useScribeTracking(isMyLine && !paused && scribeWarm, currentStep?.verbalLine ?? "", languageCode, trackingMic);

  // Nothing to record if the user isn't reading a role — just listening to
  // the scene doesn't need a camera or a self-tape. Reading a role opens the
  // camera and mic (the mic drives line tracking) whether or not this run
  // is recorded: "Just run lines" keeps the tape off.
  const willRecord = Boolean(selectedRole);
  const [recordTake, setRecordTake] = useState(true);
  const recording = willRecord && recordTake;
  // Beta: a take still waiting for its rating holds back the next recorded
  // one (FeedbackGate.tsx); running lines without a tape is never held.
  const feedbackOwed = useFeedbackOwed(user?.id);
  // A run without a tape reached its last line: offer what's next.
  const [runComplete, setRunComplete] = useState(false);

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

  // Step 4 sets up the camera and mic as it opens, so the actor can check
  // their framing before Start (and Start needn't wait on a permission
  // prompt). Released if they leave the step, when Rehearsal unmounts.
  const requestCameraRef = useRef(requestCamera);
  requestCameraRef.current = requestCamera;
  useEffect(() => {
    if (willRecord) void requestCameraRef.current();
  }, [willRecord]);

  const beginRehearsal = useCallback((record: boolean) => {
    if (record && feedbackOwed) {
      requestFeedbackGate();
      return;
    }
    setRecordTake(record);
    takeMetricsRef.current = new TakeMetrics();
    takeMetricsRef.current.liveFetchesDuringTake = 0;
    // Must run synchronously inside this click handler — the first cue plays
    // seconds later, after the countdown, well outside the user gesture that
    // autoplay policies require.
    unlock();
    setCountdown(COUNTDOWN_START);
    setStartPhase("countdown");
  }, [unlock, feedbackOwed]);

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
    if (!recording || startPhase !== "active" || recordingStartedRef.current) return;
    recordingStartedRef.current = true;
    startRecording(getTapStream(), getAudioContext());
    recordingReadyAtRef.current = Date.now() + RECORDING_SETTLE_MS;
  }, [recording, startPhase, startRecording, getTapStream, getAudioContext]);

  // Keep the script from scrolling behind the countdown.
  useEffect(() => {
    if (startPhase !== "countdown") return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [startPhase]);

  // Anything that restarts the scene from a pause (a jump, a replay) must
  // restart the tape with it, or the take silently stays paused. Through a
  // ref: the recorder's resume is a new function every render, and goTo
  // must stay stable for the memoized line rows.
  const resumeRecordingRef = useRef(resumeRecording);
  resumeRecordingRef.current = resumeRecording;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const unpause = useCallback(() => {
    if (pausedRef.current) resumeRecordingRef.current();
    pausedRef.current = false;
    setPaused(false);
  }, []);
  const goTo = useCallback((index: number) => {
    stop();
    unpause();
    setPlaybackState("waiting");
    setCurrentStepIndex(Math.max(0, Math.min(index, steps.length - 1)));
  }, [stop, unpause, steps.length]);
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

  // Replaying the scene partner's current line re-runs the playback effect
  // below, so the line still hands over to the next one when it ends.
  const [replayCount, setReplayCount] = useState(0);
  const skipBeatRef = useRef(false);
  useEffect(() => {
    const { readerCue, volumeFor, paceFor } = castRef.current;
    const skipBeat = skipBeatRef.current;
    skipBeatRef.current = false;
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
      const nextLine = readerCue(nextIndex)?.line;
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
      const timer = setTimeout(() => goNextRef.current(), SILENT_STEP_HOLD_MS);
      return () => clearTimeout(timer);
    }
    const cue = readerCue(currentStepIndex);
    if (!cue) return;
    const { line } = cue;
    const beatMs = skipBeat ? 0 : cue.beatMs;
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
        speed: paceFor(currentStepIndex),
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
    const settleDelay = recording ? Math.max(0, recordingReadyAtRef.current - Date.now()) : 0;
    const holdMs = Math.max(settleDelay, beatMs);
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    if (holdMs > 0) {
      // Fetch during the beat (a no-op when pre-generated), so it isn't
      // followed by a load wait.
      prefetch(line, intensity);
      holdTimer = setTimeout(startPlayback, holdMs);
    } else startPlayback();
    return () => { if (holdTimer) clearTimeout(holdTimer); controller.abort(); stop(); };
  }, [currentStepIndex, steps, selectedRole, paused, startPhase, intensity, play, prefetch, stop, recording, replayCount]);

  const lineDetected = isMyLine && lineWordCount > 0 && matchedWordCount >= lineWordCount;
  useEffect(() => {
    // No wait: detection never regresses (the matched count only climbs, so
    // a rewritten partial can't un-detect the line), and any delay here is
    // dead air before the reader answers. Only reached once the line's
    // ending has been heard (or after the long patient hold, see
    // lib/lineMatch.ts).
    if (lineDetected) goNextRef.current();
  }, [lineDetected]);

  // Both the natural end of the script and the manual Stop button end the
  // audition the same way: save the take, then land on its tile in My
  // Scripts so the user can immediately review, download, or delete it.
  const endRehearsal = useCallback(async () => {
    // Pre-generation's duration (to its finish, or to now if it's still
    // going) and how many lines it gave up on.
    const { startedAt, finishedAt, failed } = pregenRef.current;
    const metrics = takeMetricsRef.current;
    metrics.pregenMs = startedAt === null ? null : (finishedAt ?? Date.now()) - startedAt;
    metrics.pregenFailedLines = startedAt === null ? null : failed;
    // finishRecording() guards its own errors, but nothing may skip the
    // navigate below: without it the rehearsal is stuck on-screen.
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
    if (!lastLineFinished || paused || startPhase !== "active" || finishedRef.current) return;
    finishedRef.current = true;
    recordMyLineAdvance();
    setPaused(true);
    if (!recording) {
      setRunComplete(true);
      return;
    }
    setComplete(true);
    void endRehearsal();
  }, [recording, lastLineFinished, paused, startPhase, endRehearsal, recordMyLineAdvance]);

  const cueIndex = useMemo(() => {
    if (!isMyLine) return currentStepIndex;
    for (let index = currentStepIndex - 1; index >= 0; index -= 1) {
      if (steps[index].verbalLine.trim()) return index;
    }
    return undefined;
  }, [isMyLine, steps, currentStepIndex]);
  const cueStep = cueIndex === undefined ? null : steps[cueIndex];

  // Plays at once, with no beat: the actor asked for the cue, so a beat
  // would only read as lag.
  const replayCue = useCallback(() => {
    if (cueIndex === undefined) return;
    if (!isMyLine) {
      skipBeatRef.current = true;
      unpause();
      setReplayCount((count) => count + 1);
      return;
    }
    const line = ttsLine(cueIndex);
    if (!line) return;
    stop();
    unpause();
    setFailureReason(null);
    setPlaybackState("playing");
    play(line, {
      intensity,
      volume: volumeFor(cueIndex),
      speed: paceFor(cueIndex),
      onFallback: (reason) => { setFailureReason(reason); setPlaybackState("error"); },
      onEnded: () => setPlaybackState("ready"),
    }).catch((error) => {
      if (error?.name !== "AbortError") { setFailureReason(error?.message ?? null); setPlaybackState("error"); }
    });
  }, [cueIndex, ttsLine, volumeFor, paceFor, intensity, isMyLine, play, stop, unpause]);

  const togglePause = useCallback(() => {
    const pausing = !pausedRef.current;
    // Ahead of the render, so a second toggle in the same tick sees this one.
    pausedRef.current = pausing;
    if (pausing) { stop(); setPlaybackState("paused"); pauseRecording(); }
    else { resumeRecording(); }
    setPaused(pausing);
  }, [stop, pauseRecording, resumeRecording]);

  // The camera dropped out mid-take (see useSelfTapeRecorder): pause the
  // scene and the tape together, so the take holds still instead of
  // recording a frozen picture under the audio. Resuming while it's still
  // out just pauses again.
  useEffect(() => {
    if (cameraInterrupted && recording && !paused && startPhase === "active") togglePause();
  }, [cameraInterrupted, recording, paused, startPhase, togglePause]);

  const stopRecordingManually = useCallback(() => {
    stop();
    setPaused(true);
    finishedRef.current = true;
    if (!recording) {
      setRunComplete(true);
      return;
    }
    void endRehearsal();
  }, [stop, endRehearsal, recording]);

  // iOS app: going to the background finished the take natively and turned
  // the camera and mic off. End the take so it's saved like any other.
  useEffect(() => {
    if (endedInBackground && startPhase === "active" && !finishedRef.current) stopRecordingManually();
  }, [endedInBackground, startPhase, stopRecordingManually]);

  // Ending a take early asks first — the scene pauses meanwhile, and picks
  // back up if the actor keeps going.
  const [confirmingStop, setConfirmingStop] = useState(false);
  const pausedForConfirmRef = useRef(false);
  const requestStop = useCallback(() => {
    if (!recording || currentStepIndex >= steps.length - 1) {
      stopRecordingManually();
      return;
    }
    pausedForConfirmRef.current = !paused;
    if (!paused) togglePause();
    setConfirmingStop(true);
  }, [recording, currentStepIndex, steps.length, paused, togglePause, stopRecordingManually]);
  const keepGoing = useCallback(() => {
    setConfirmingStop(false);
    if (pausedForConfirmRef.current) togglePause();
    pausedForConfirmRef.current = false;
  }, [togglePause]);
  const confirmStop = useCallback(() => {
    setConfirmingStop(false);
    pausedForConfirmRef.current = false;
    stopRecordingManually();
  }, [stopRecordingManually]);

  // From the "Scene complete" card: the same scene again, from the top.
  const runAgain = useCallback((record: boolean) => {
    finishedRef.current = false;
    setRunComplete(false);
    stop();
    setPlaybackState("waiting");
    setCurrentStepIndex(0);
    if (record) {
      // Back through Start, so recording gets its countdown and setup.
      setRecordTake(true);
      setStartPhase("idle");
      return;
    }
    setPaused(false);
  }, [stop]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (startPhase !== "active") return;
      if (confirmingStop || runComplete) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, select, textarea")) return;
      // A focused button keeps Space and Enter for itself; the rest still
      // work, or the shortcuts would die after any tap on the control bar.
      if (target?.matches("button, a") && (event.code === "Space" || event.key === "Enter")) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "ArrowRight") goNext();
      if (event.key === "ArrowLeft") goPrev();
      if (event.key.toLowerCase() === "r") replayCue();
      if (event.key.toLowerCase() === "h" && selectedRole) setLineMode((mode) => mode === "hidden" ? "full" : "hidden");
      if (event.code === "Space") { event.preventDefault(); togglePause(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [startPhase, confirmingStop, runComplete, selectedRole, goNext, goPrev, replayCue, togglePause]);

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

  const trackingMyLine = isMyLine && !paused && startPhase === "active" && !lineDetected && playbackState !== "playing";
  const micMissing = useElapsed(String(currentStepIndex), MIC_MISSING_AFTER_MS, trackingMyLine && !listening);
  const lineStalled = useElapsed(`${currentStepIndex}:${matchedWordCount}`, STALLED_LINE_HINT_MS, trackingMyLine && listening);
  const toggleLineMode = useCallback(() => setLineMode((mode) => mode === "hidden" ? "full" : "hidden"), []);

  if (!currentStep) return null;
  if (startPhase === "idle") {
    return (
      <RehearsalSetup
        scriptName={fileName}
        onGoToStep={onGoToStep}
        pregen={pregen}
        willRecord={willRecord}
        cameraStatus={recorderStatus}
        cameraStream={cameraStream}
        cameraError={recorderError}
        onRetryCamera={() => void requestCamera()}
        onSwitchDevice={(kind, choice) => void switchDevice(kind, choice)}
        cameraZoom={cameraZoom}
        onZoom={setCameraZoom}
        scriptSaved={scriptSaved}
        onStart={() => beginRehearsal(willRecord)}
        onPracticeRun={willRecord ? () => beginRehearsal(false) : undefined}
        onBack={onBack}
        nativePreview={nativePreview}
      />
    );
  }
  const progress = ((currentStepIndex + 1) / steps.length) * 100;
  const partnerName = currentSpeaker ? displayCharacterName(currentSpeaker) : "Scene partner";
  const endLabel = recording ? "End take" : "Finish";
  const carryOn = isLastStep ? `tap ${endLabel}` : "tap Next";
  // The service's own wording is for whoever is debugging, not the actor.
  const devFailureNote = import.meta.env.DEV && failureReason ? ` (${failureReason})` : "";
  const status: RehearsalStatus = startPhase === "countdown"
    ? { kind: "waiting", title: `Starting in ${countdown}`, detail: recording ? "Recording starts with the scene." : "" }
    : complete
      ? { kind: "done", title: "Scene complete", detail: "Saving your take…" }
      : runComplete
        ? { kind: "done", title: "Scene complete", detail: "" }
        : paused && cameraInterrupted
          ? { kind: "paused", title: "Paused", detail: `Your camera was interrupted. Tap Resume once it’s back, or ${endLabel} to keep what you have.` }
          : paused
            ? { kind: "paused", title: "Paused", detail: "Tap Resume when you’re ready." }
            : playbackState === "error"
              ? { kind: "error", title: `Couldn’t play ${isMyLine ? "your cue" : `${partnerName}’s line`}`, detail: `Tap Replay to try again, or ${carryOn} to carry on.${devFailureNote}` }
              : lineDetected
                ? { kind: "you", title: "Got it", detail: "" }
                : isMyLine && micMissing
                  ? { kind: "hint", title: "Your line", detail: `The mic isn’t following along. Say your line, then ${carryOn}.` }
                  : isMyLine && lineStalled
                    ? { kind: "hint", title: "Your line", detail: `Didn’t catch that. Keep going, or ${carryOn}.` }
                    : isMyLine && playbackState === "playing"
                      ? { kind: "partner", title: "Your cue", detail: "Replaying. Your line is next." }
                      : isMyLine
                        ? { kind: "you", title: "Your line", detail: "Listening. Go ahead." }
                        : playbackState === "playing"
                          ? { kind: "partner", title: partnerName, detail: selectedRole ? "Speaking. Listen for your cue." : "Speaking." }
                          : !currentStep.verbalLine.trim()
                            ? { kind: "waiting", title: "Stage direction", detail: isLastStep ? `Tap ${endLabel} when you’re done.` : "Carrying on in a moment." }
                            : { kind: "waiting", title: partnerName, detail: "Up next…" };

  return (
    <main className="rehearsal-page">
      <h1 className="sr-only">Rehearsal: {fileName}</h1>
      <header className="rehearsal-header">
        <button
          type="button"
          className="rehearsal-back"
          onClick={() => { if (confirmExit()) onBack(); }}
          aria-label="Back to role and voice setup"
          title="Back to setup"
        >
          <span aria-hidden="true">←</span>
        </button>
        <span className="rehearsal-file" title={fileName}>{fileName}</span>
        <p className="rehearsal-count">
          <span className="sr-only">Rehearsal: </span>
          Line {currentStepIndex + 1} of {steps.length}
        </p>
        <Link to="/" className="btn-ghost rehearsal-exit" onClick={(event) => { if (!confirmExit()) event.preventDefault(); }}>Exit</Link>
      </header>
      <div className="rehearsal-progress"><i style={{ width: `${progress}%` }} /></div>
      <RehearsalStatusStrip status={status} />

      {/* Two columns only with the camera beside the script; just listening,
          the script takes the centre. */}
      <div className={`rehearsal-workspace ${willRecord && scriptSaved ? "has-camera" : ""}`}>
        {willRecord && scriptSaved && (
          <SelfTapeRecorder
            status={recorderStatus}
            stream={cameraStream}
            error={recorderError}
            practiceRun={!recording}
            nativePreview={nativePreview}
            onRetry={nativePreview ? () => void requestCamera() : undefined}
          />
        )}

        <section className="rehearsal-center">
          <RehearsalLineList
            steps={steps}
            currentIndex={currentStepIndex}
            selectedRole={selectedRole}
            lineMode={lineMode}
            isMyLine={isMyLine}
            matchedWordCount={matchedWordCount}
            onJump={goTo}
          />
        </section>

        {startPhase === "countdown" && (
          <div className="rehearsal-overlay">
            {/* Announced by the status strip, the one live region. */}
            <div className="rehearsal-countdown" key={countdown} aria-hidden="true">{countdown}</div>
          </div>
        )}

        {runComplete && (
          <div className="rehearsal-overlay">
            <div className="rehearsal-done" role="dialog" aria-modal="true" aria-labelledby="rehearsal-done-title">
              <h2 id="rehearsal-done-title" className="modal-title">Scene complete</h2>
              <p className="modal-copy">
                {willRecord
                  ? "Nice run. Go again, or record a take now that you’re warmed up."
                  : "That’s the whole scene."}
              </p>
              <div className="rehearsal-done-actions">
                {willRecord && (
                  <button type="button" className="btn-primary" onClick={() => runAgain(true)} autoFocus>
                    Record a take
                  </button>
                )}
                <button
                  type="button"
                  className={willRecord ? "btn-secondary" : "btn-primary"}
                  onClick={() => runAgain(false)}
                >
                  Run it again
                </button>
                <button type="button" className="btn-ghost" onClick={onBack}>
                  Back to setup
                </button>
              </div>
            </div>
          </div>
        )}

        {confirmingStop && (
          <Modal onClose={keepGoing} labelledBy="end-take-title" className="is-compact">
            <h2 id="end-take-title" className="modal-title">End this take?</h2>
            <p className="modal-copy">
              You’re on line {currentStepIndex + 1} of {steps.length}. Ending now saves the take
              so far to My Auditions.
            </p>
            <div className="modal-actions">
              <button type="button" className="modal-secondary" onClick={keepGoing} data-autofocus>
                Keep going
              </button>
              <button type="button" className="modal-primary" onClick={confirmStop}>
                End and save take
              </button>
            </div>
          </Modal>
        )}
      </div>
      <RehearsalControlBar
        disabled={startPhase !== "active" || complete || runComplete}
        paused={paused}
        onTogglePause={togglePause}
        canPrev={currentStepIndex > 0}
        onPrev={goPrev}
        canNext={!isLastStep}
        onNext={goNext}
        canReplay={Boolean(cueStep)}
        onReplay={replayCue}
        linesHidden={lineMode === "hidden"}
        onToggleLines={selectedRole ? toggleLineMode : undefined}
        endLabel={endLabel}
        ending={recorderSaving}
        onEnd={requestStop}
      />
    </main>
  );
}
