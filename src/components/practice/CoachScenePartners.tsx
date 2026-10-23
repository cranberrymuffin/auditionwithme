import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Step } from "../../types";
import { displayCharacterName, normalizeSpeaker } from "../../lib/script";
import { buildReaderCue, readerLineIndices } from "../../lib/readerLines";
import { clampCharacterPace } from "../../lib/characterDelivery";
import { clampCharacterVolume } from "../../lib/characterVolume";
import { saveCoachTake } from "../../lib/coachTakeStore";
import { useTtsPlayer } from "../../hooks/useTtsPlayer";
import SetupStep from "./SetupStep";

// Longest take a line can have: generous for any one line of dialogue, and
// what api/sts.ts accepts (its MAX_TAKE_SECONDS).
export const MAX_COACH_TAKE_SECONDS = 60;
// Shorter than this is a mis-tap, not a read.
const MIN_TAKE_MS = 400;

type Busy = {
  index: number;
  phase: "requesting" | "recording" | "converting" | "playing";
};

const formatElapsed = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

function micErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Your browser is blocking the microphone for this site. Allow it from the address bar, then try again.";
  }
  if (name === "NotFoundError") {
    return "We couldn’t find a microphone. Connect one, then try again.";
  }
  return "We couldn’t start the microphone. Check your browser permissions, then try again.";
}

/**
 * Optional, from step 3: the actor reads the scene partners' lines the way
 * they want to hear them, and each take is re-voiced as its character by
 * speech-to-speech (api/sts.ts) — their timing, emphasis and emotion, the
 * character's voice. Takes stay on-device (coachTakeStore.ts); Rehearsal and
 * pre-generation play a coached line in place of its AI read
 * (buildReaderCue). Every take is kept as soon as it's recorded, so leaving
 * is always just Done.
 */
export default function CoachScenePartners({
  scriptName,
  steps,
  selectedRole,
  scriptId,
  characterVoices,
  characterVolumes,
  characterPaces,
  coachTakes,
  onTakeChange,
  onDone,
  onGoToStep,
}: {
  scriptName: string;
  steps: Step[];
  selectedRole: string;
  scriptId: string;
  characterVoices: Record<string, string>;
  characterVolumes: Record<string, number>;
  characterPaces: Record<string, number>;
  /** Step index → the take currently coaching that line. */
  coachTakes: Record<number, string>;
  /** A line's take was recorded (an id) or removed (null). */
  onTakeChange: (stepIndex: number, takeId: string | null) => void;
  onDone: () => void;
  onGoToStep: (step: number) => void;
}) {
  // Only for load(): finding or making a line's audio, cached and stored
  // like any reader line. Previews play on the plain element below instead
  // of through the player's Web Audio graph, which exists to mix the reader
  // into a self-tape — nothing this screen needs, and one more thing to go
  // silent around the microphone opening and closing.
  const { load } = useTtsPlayer({ scriptId });
  const previewRef = useRef<HTMLAudioElement | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const stop = useCallback(() => {
    previewRef.current?.pause();
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = null;
  }, []);
  const partnerLines = useMemo(
    () => readerLineIndices(steps, selectedRole),
    [steps, selectedRole],
  );
  const partnerSet = useMemo(() => new Set(partnerLines), [partnerLines]);
  const coachedCount = partnerLines.filter((index) => coachTakes[index]).length;

  const [activeIndex, setActiveIndex] = useState<number | null>(
    () => partnerLines.find((index) => !coachTakes[index]) ?? partnerLines[0] ?? null,
  );
  const [busy, setBusy] = useState<Busy | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<{ index: number; message: string } | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const autoStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rowRefs = useRef(new Map<number, HTMLLIElement>());
  // Set on unmount, so a conversion finishing late doesn't play into a
  // screen that's gone.
  const unmountedRef = useRef(false);

  const previousSelection = useRef(activeIndex);
  useEffect(() => {
    // Keep the introduction visible on arrival; scroll only after selection.
    if (previousSelection.current === activeIndex) return;
    previousSelection.current = activeIndex;
    if (activeIndex === null) return;
    rowRefs.current.get(activeIndex)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeIndex]);

  useEffect(() => {
    if (busy?.phase !== "recording") return;
    const timer = setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000)),
      250,
    );
    return () => clearInterval(timer);
  }, [busy]);

  // Reset on (re)mount: StrictMode runs this cleanup once on a dev mount
  // and mounts again, which would otherwise leave the screen thinking it's
  // gone — every Record click returning before it starts.
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      if (autoStopRef.current) clearTimeout(autoStopRef.current);
      if (recorderRef.current?.state === "recording") {
        recorderRef.current.onstop = null;
        recorderRef.current.stop();
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      stop();
    };
  }, [stop]);

  const speakerOf = (index: number) => normalizeSpeaker(steps[index]?.speaker ?? "");

  /** Converts (or finds) the coached line's audio, then plays it. False if
   * it couldn't (the error is showing on the line). */
  const hear = async (index: number, takeId: string): Promise<boolean> => {
    const cue = buildReaderCue(steps, index, characterVoices, [], {}, { [index]: takeId });
    if (!cue) return false;
    stop();
    setError(null);
    setBusy({ index, phase: "converting" });
    let blob: Blob;
    try {
      blob = await load(cue.line);
    } catch (err) {
      console.error("Coached line conversion failed:", err);
      if (unmountedRef.current) return false;
      setBusy(null);
      setError({
        index,
        message: `Couldn’t make ${displayCharacterName(speakerOf(index))}’s read: ${
          err instanceof Error ? err.message : "something went wrong"
        }. Hear it again to retry.`,
      });
      return false;
    }
    if (unmountedRef.current) return false;
    const speaker = speakerOf(index);
    stop();
    // A fresh element per preview, so its listeners never pile up.
    const audio = new Audio();
    previewRef.current = audio;
    const url = URL.createObjectURL(blob);
    previewUrlRef.current = url;
    audio.src = url;
    audio.playbackRate = clampCharacterPace(characterPaces[speaker]);
    // An element can't go past full volume; the rehearsal can (its gain).
    audio.volume = Math.min(clampCharacterVolume(characterVolumes[speaker]), 1);
    audio.onended = () => setBusy(null);
    setBusy({ index, phase: "playing" });
    try {
      await audio.play();
    } catch (err) {
      console.error("Coached line playback failed:", err);
      setBusy(null);
      setError({
        index,
        message: "Your browser blocked playback. Tap Hear it to play the line.",
      });
      return false;
    }
    return true;
  };

  const startRecording = async (index: number) => {
    stop();
    setError(null);
    setActiveIndex(index);
    // Can wait on the browser's microphone prompt (the first take).
    setBusy({ index, phase: "requesting" });
    try {
      streamRef.current ??= await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (err) {
      setBusy(null);
      setError({ index, message: micErrorMessage(err) });
      return;
    }
    if (unmountedRef.current) return;
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(streamRef.current);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => void finishTake(index, recorder.mimeType);
      recorder.start();
    } catch (err) {
      console.error("Couldn't start recording:", err);
      setBusy(null);
      setError({ index, message: "This browser couldn’t start recording. Try Chrome or Safari." });
      return;
    }
    recorderRef.current = recorder;
    startedAtRef.current = Date.now();
    setElapsed(0);
    setBusy({ index, phase: "recording" });
    autoStopRef.current = setTimeout(stopRecording, MAX_COACH_TAKE_SECONDS * 1000);
  };

  function stopRecording() {
    if (autoStopRef.current) clearTimeout(autoStopRef.current);
    autoStopRef.current = null;
    if (recorderRef.current?.state === "recording") {
      recorderRef.current.stop();
      return;
    }
    // The recorder already stopped without us (its microphone went away, or
    // a dev hot reload ran the cleanup below): nothing will finish the take,
    // so don't leave Stop showing with nothing behind it.
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setBusy(null);
    setError({
      index: busy?.index ?? activeIndex ?? 0,
      message: "The recording stopped before you did. Tap Record to try again.",
    });
  }

  const finishTake = async (index: number, mimeType: string) => {
    // Released between takes: no microphone light while listening back, and
    // Bluetooth headphones drop out of their low-quality call mode.
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    const duration = Date.now() - startedAtRef.current;
    const blob = new Blob(chunksRef.current, mimeType ? { type: mimeType } : undefined);
    chunksRef.current = [];
    if (duration < MIN_TAKE_MS || !blob.size) {
      setBusy(null);
      setError({ index, message: "That take was too short. Tap Record and read the whole line." });
      return;
    }
    const id = crypto.randomUUID();
    try {
      await saveCoachTake({
        id,
        scriptId,
        stepIndex: index,
        text: steps[index].verbalLine,
        blob,
        size: blob.size,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error("Couldn't save the coached take:", err);
      setBusy(null);
      setError({ index, message: "Couldn’t save that take on this device. Please try again." });
      return;
    }
    if (unmountedRef.current) return;
    onTakeChange(index, id);
    // Stays on the line to listen back; the actor picks the next line to
    // coach themselves.
    await hear(index, id);
  };

  /** Makes `index` the line being coached, stopping any read playing. */
  const selectLine = (index: number) => {
    if (busy?.phase === "playing") {
      stop();
      setBusy(null);
    }
    setError(null);
    setActiveIndex(index);
  };

  // Free to switch lines (or hear one) while a read plays; not mid-take, or
  // while a take is still being turned into the character's voice.
  const switchLocked = busy !== null && busy.phase !== "playing";

  return (
    <SetupStep className="processing-page coaching-page" step={3} scriptName={scriptName} onGoToStep={switchLocked ? undefined : onGoToStep}>
      <header className="coach-intro">
        <h1>Coach your scene partners</h1>
        <p>Read each of your scene partners’ lines the way you want to hear it. We’ll turn your read into that character’s voice, keeping your timing, emphasis and emotion. Any line you skip keeps its AI read.</p>
      </header>

      <ol className="coach-script" aria-label="Scene dialogue">
        {steps.map((step, index) => {
          if (!step.verbalLine.trim()) return null;
          const speaker = normalizeSpeaker(step.speaker);
          const name = displayCharacterName(speaker);
          if (!partnerSet.has(index)) {
            return (
              <li key={index} className="coach-line coach-line--yours">
                <span className="coach-speaker">{name}<span className="coach-you-label">you</span></span>
                <span className="coach-text">{step.verbalLine}</span>
              </li>
            );
          }
          const takeId = coachTakes[index];
          const active = activeIndex === index;
          const lineBusy = busy?.index === index ? busy.phase : null;
          const voiceMissing = !characterVoices[speaker];
          return (
            <li
              key={index}
              ref={(node) => {
                if (node) rowRefs.current.set(index, node);
                else rowRefs.current.delete(index);
              }}
              className={`coach-line ${active ? "is-active" : ""} ${takeId ? "is-coached" : ""}`}
            >
              <div className="coach-speaker">
                {name}
                {takeId && (
                  <>
                    <button
                      type="button"
                      className="coach-hear"
                      disabled={switchLocked}
                      onClick={() => {
                        selectLine(index);
                        void hear(index, takeId);
                      }}
                    >
                      <span aria-hidden="true">▶</span> Hear it
                    </button>
                  </>
                )}
              </div>
              {/* Stretched over the whole row (CSS), so clicking anywhere on
                  the line but Hear it picks it. */}
              <button
                type="button"
                className="coach-line-select"
                aria-current={active ? "step" : undefined}
                aria-label={`${name}: ${step.verbalLine}`}
                disabled={switchLocked}
                onClick={() => selectLine(index)}
              >
                <span className="coach-text">{step.verbalLine}</span>
              </button>
              {active && (
                <div className="coach-line-actions">
                  {lineBusy === "recording" ? (
                    <button
                      type="button"
                      className="coach-record is-recording"
                      onClick={stopRecording}
                    >
                      <span aria-hidden="true">■</span> Stop · {formatElapsed(elapsed)}
                    </button>
                  ) : (
                    // Hidden, not greyed out, while it can't be used: the
                    // status beside it says why.
                    !voiceMissing &&
                    busy === null && (
                      <button
                        type="button"
                        className="coach-record"
                        onClick={() => void startRecording(index)}
                      >
                        <span aria-hidden="true">●</span> {takeId ? "Record again" : "Record"}
                      </button>
                    )
                  )}
                  <span className="coach-status" role="status">
                    {lineBusy === "requesting"
                      ? "Allow the microphone in your browser’s prompt…"
                      : lineBusy === "converting"
                      ? `Making ${name}’s read…`
                      : lineBusy === "playing"
                        ? `Playing ${name}’s read`
                        : voiceMissing
                          ? `Waiting for ${name}’s voice…`
                          : ""}
                  </span>
                  {lineBusy === "playing" && (
                    <button type="button" className="coach-text-button" onClick={() => { stop(); setBusy(null); }}>Stop playback</button>
                  )}
                  {!switchLocked && partnerLines.indexOf(index) < partnerLines.length - 1 && (
                    <button type="button" className="coach-next-line" onClick={() => selectLine(partnerLines[partnerLines.indexOf(index) + 1])}>Next line <span aria-hidden="true">↓</span></button>
                  )}
                  {error?.index === index && (
                    <p className="coach-error" role="alert">
                      {error.message}
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>

      <details className="coach-help">
        <summary>About your recordings</summary>
        <p>Takes are saved on this device and sent to ElevenLabs for voice conversion when played. Pace and Volume still apply; your delivery sets the emotion.</p>
      </details>
      {partnerLines.length === 0 && <p className="coach-empty">There are no scene partner lines to coach. Head back to choose your voices.</p>}
      <footer className="coach-footer">
        <span className="coach-count" role="status">{coachedCount ? `${coachedCount} of ${partnerLines.length} lines coached` : "Coaching is optional"}</span>
        <button
          type="button"
          className="setup-next"
          disabled={switchLocked}
          onClick={() => {
            stop();
            onDone();
          }}
        >
          Done <span aria-hidden="true">→</span>
        </button>
      </footer>
    </SetupStep>
  );
}
