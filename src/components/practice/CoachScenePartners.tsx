import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Step } from "../../types";
import { displayCharacterName, normalizeSpeaker } from "../../lib/script";
import { buildReaderCue, readerLineIndices } from "../../lib/readerLines";
import { clampCharacterPace } from "../../lib/characterDelivery";
import { clampCharacterVolume } from "../../lib/characterVolume";
import { deleteCoachTake, saveCoachTake } from "../../lib/coachTakeStore";
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

  useEffect(() => {
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
    const audio = (previewRef.current ??= new Audio());
    stop();
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
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
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
    const next =
      partnerLines.find((line) => line > index && !coachTakes[line]) ??
      partnerLines.find((line) => line > index);
    // Stays on the line if its read couldn't be made, so the error shows.
    const heard = await hear(index, id);
    if (heard && !unmountedRef.current && next !== undefined) setActiveIndex(next);
  };

  const removeTake = (index: number) => {
    const takeId = coachTakes[index];
    if (!takeId) return;
    stop();
    setBusy(null);
    onTakeChange(index, null);
    void deleteCoachTake(takeId).catch((err) =>
      console.warn("Couldn't delete the coached take:", err),
    );
  };

  const recording = busy?.phase === "recording";

  return (
    <SetupStep step={3} scriptName={scriptName} onGoToStep={onGoToStep}>
      <div className="role-intro">
        <h1>Coach your scene partners</h1>
      </div>
      <p className="processing-explanation">
        Read each of your scene partners’ lines the way you want to hear it.
        We’ll turn your read into that character’s voice, keeping your timing,
        emphasis and emotion. Any line you skip keeps its AI read.
      </p>
      <p className="coach-privacy">
        Your recordings stay on this device. To make a character’s read, each
        one is sent to ElevenLabs, our voice provider. Pace and Volume still
        apply to coached lines; Emotion doesn’t.
      </p>
      <p className="coach-progress" role="status">
        {coachedCount} of {partnerLines.length} lines coached
      </p>

      <ol className="coach-script">
        {steps.map((step, index) => {
          if (!step.verbalLine.trim()) return null;
          const speaker = normalizeSpeaker(step.speaker);
          const name = displayCharacterName(speaker);
          if (!partnerSet.has(index)) {
            return (
              <li key={index} className="coach-line coach-line--yours">
                <span className="coach-speaker">{name} (you)</span>
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
              <button
                type="button"
                className="coach-line-select"
                aria-current={active ? "step" : undefined}
                disabled={busy !== null}
                onClick={() => setActiveIndex(index)}
              >
                <span className="coach-speaker">
                  {name}
                  {takeId && <span className="coach-badge">Coached</span>}
                </span>
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
                    <button
                      type="button"
                      className="coach-record"
                      disabled={voiceMissing || busy !== null}
                      onClick={() => void startRecording(index)}
                    >
                      <span aria-hidden="true">●</span> {takeId ? "Record again" : "Record"}
                    </button>
                  )}
                  {takeId && (
                    <>
                      <button
                        type="button"
                        className="speaker-test"
                        disabled={busy !== null}
                        onClick={() => void hear(index, takeId)}
                      >
                        Hear it
                      </button>
                      <button
                        type="button"
                        className="speaker-test"
                        disabled={recording}
                        onClick={() => removeTake(index)}
                      >
                        Use the AI read
                      </button>
                    </>
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

      <div className="script-accordion-actions role-actions">
        <button
          type="button"
          className="setup-next"
          disabled={recording}
          onClick={() => {
            stop();
            onDone();
          }}
        >
          Done coaching <span aria-hidden="true">→</span>
        </button>
      </div>
    </SetupStep>
  );
}
