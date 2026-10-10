import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ReaderAudioPregenState } from "../../hooks/useReaderAudioPregen";
import { isIpad } from "../../hooks/useSelfTapeRecorder";
import SetupStep from "./SetupStep";

type RecorderStatus =
  | "idle"
  | "requesting"
  | "ready"
  | "recording"
  | "paused"
  | "error";

// If the opening lines still aren't pre-generated after this long (a busy
// account, a slow network), offer to start anyway — those lines then fetch
// live during the take instead of keeping the actor waiting here.
const START_ANYWAY_AFTER_MS = 20_000;
// Share of the scene partner's lines pre-generated before Start rehearsal
// opens up (the opening lines must be ready too).
const READY_TO_START_SHARE = 0.25;
// Bars in the microphone's level meter, and the level (RMS of the waveform,
// 0–1) that lights them all: ordinary speaking sits around 0.05–0.15.
const MIC_METER_BARS = 5;
const MIC_FULL_SCALE = 0.2;
// The browser's camera/mic prompt is easy to miss (or dismiss): after this
// long still waiting on it, point the actor at it.
const PERMISSION_NUDGE_AFTER_MS = 5_000;

/** Strips Chrome's "Default - " prefix from the default output's label. */
const speakerName = (label: string) => label.replace(/^Default - /, "");

// Only browsers that can route audio to a chosen output (Chrome, Edge) list
// outputs at all; elsewhere an empty list says nothing, so assume one.
const listsAudioOutputs =
  typeof AudioContext !== "undefined" && "setSinkId" in AudioContext.prototype;

/** The output the scene partner will play through, by name where the
 * browser says (Chrome, once mic access has unlocked device labels), and
 * whether there is one at all. */
function useSpeaker(refreshKey: unknown): { label: string; found: boolean } {
  const [speaker, setSpeaker] = useState({
    label: "System default",
    found: true,
  });
  useEffect(() => {
    const devices = navigator.mediaDevices;
    if (!devices?.enumerateDevices) return;
    let active = true;
    const read = () =>
      void devices
        .enumerateDevices()
        .then((all) => {
          if (!active) return;
          const outputs = all.filter((d) => d.kind === "audiooutput");
          if (outputs.length === 0) {
            if (listsAudioOutputs)
              setSpeaker({ label: "No speaker detected", found: false });
            return;
          }
          const labelled = outputs.filter((d) => d.label);
          const output =
            labelled.find((d) => d.deviceId === "default") ?? labelled[0];
          setSpeaker({
            label: output ? speakerName(output.label) : "System default",
            found: true,
          });
        })
        .catch(() => {});
    read();
    devices.addEventListener?.("devicechange", read);
    return () => {
      active = false;
      devices.removeEventListener?.("devicechange", read);
    };
  }, [refreshKey]);
  return speaker;
}

/** Plays a short two-note chime: enough to hear, nothing to sit through. */
function playTestChime(context: AudioContext) {
  const start = context.currentTime + 0.05;
  [660, 880].forEach((frequency, i) => {
    const at = start + i * 0.22;
    const tone = context.createOscillator();
    const gain = context.createGain();
    tone.type = "sine";
    tone.frequency.value = frequency;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.25, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, at + 0.5);
    tone.connect(gain).connect(context.destination);
    tone.start(at);
    tone.stop(at + 0.5);
  });
}

/** Live level of the microphone in `stream`, as bars that light up while
 * the actor speaks. Updates the bars directly each frame, not via state. */
function MicLevel({
  stream,
  context,
}: {
  stream: MediaStream;
  context: AudioContext;
}) {
  const barsRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let frame = 0;
    const draw = () => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      const level = Math.min(
        1,
        Math.sqrt(sum / samples.length) / MIC_FULL_SCALE,
      );
      const lit = Math.round(level * MIC_METER_BARS);
      barsRef.current?.querySelectorAll("i").forEach((bar, i) => {
        bar.classList.toggle("is-lit", i < lit);
      });
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => {
      cancelAnimationFrame(frame);
      source.disconnect();
    };
  }, [stream, context]);
  return (
    <span className="mic-level" ref={barsRef} aria-hidden="true">
      {Array.from({ length: MIC_METER_BARS }, (_, i) => (
        <i key={i} />
      ))}
    </span>
  );
}

/**
 * Step 4: the last stop before the take. The scene partner's lines are
 * pre-generated while the camera and microphone are set up beside them;
 * the progress bar becomes Start rehearsal once both are ready.
 *
 * Rendered by Rehearsal itself, not as a step of its own, so Start's click
 * unlocks audio on the very player the take then uses.
 */
export default function RehearsalSetup({
  scriptName,
  onGoToStep,
  pregen,
  willRecord,
  cameraStatus,
  cameraStream,
  cameraError,
  onRetryCamera,
  scriptSaved,
  onStart,
  onPracticeRun,
  onBack,
}: {
  scriptName: string;
  /** Back to an earlier step (1-based), from the header's step bars. */
  onGoToStep?: (step: number) => void;
  pregen: ReaderAudioPregenState;
  /** Reading a role: there's a self-tape, so a camera to set up. */
  willRecord: boolean;
  cameraStatus: RecorderStatus;
  cameraStream: MediaStream | null;
  cameraError: string | null;
  onRetryCamera: () => void;
  /** The take is saved under the script's record, so it must exist. */
  scriptSaved: boolean;
  onStart: () => void;
  /** Run the scene without recording — only offered when there'd be a tape. */
  onPracticeRun?: () => void;
  /** Back to the scene partners step. */
  onBack: () => void;
}) {
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const [startAnywayOffered, setStartAnywayOffered] = useState(false);

  useEffect(() => {
    if (previewRef.current) previewRef.current.srcObject = cameraStream;
  }, [cameraStream]);

  useEffect(() => {
    const timer = setTimeout(
      () => setStartAnywayOffered(true),
      START_ANYWAY_AFTER_MS,
    );
    return () => clearTimeout(timer);
  }, []);

  const linesReady =
    pregen.done ||
    (pregen.canStart &&
      pregen.total > 0 &&
      pregen.ready / pregen.total >= READY_TO_START_SHARE);
  const linesStartable = linesReady || startAnywayOffered || pregen.failed > 0;
  const allLinesReady =
    pregen.done || (pregen.total > 0 && pregen.ready >= pregen.total);
  const cameraReady = !willRecord || Boolean(cameraStream);
  const canStart =
    linesStartable && cameraReady && (!willRecord || scriptSaved);
  const directing =
    pregen.waitingForDirection || (pregen.total === 0 && !pregen.done);

  // Step 4's own audio graph for the speaker and mic checks, apart from the
  // player's (which is mixed into the self-tape). Browsers may start it
  // suspended until a gesture, so any click on the step resumes it.
  const [checkAudio, setCheckAudio] = useState<AudioContext | null>(null);
  useEffect(() => {
    const context = new AudioContext();
    const resume = () => void context.resume().catch(() => {});
    resume();
    window.addEventListener("pointerdown", resume);
    setCheckAudio(context);
    return () => {
      window.removeEventListener("pointerdown", resume);
      void context.close().catch(() => {});
    };
  }, []);
  const speaker = useSpeaker(cameraStream);
  const testSpeakers = () => {
    if (!checkAudio) return;
    void checkAudio.resume().catch(() => {});
    playTestChime(checkAudio);
  };

  const [permissionSlow, setPermissionSlow] = useState(false);
  useEffect(() => {
    setPermissionSlow(false);
    if (!willRecord || cameraStream || cameraStatus === "error") return;
    const timer = setTimeout(() => setPermissionSlow(true), PERMISSION_NUDGE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [willRecord, cameraStream, cameraStatus]);

  const videoTrack = cameraStream?.getVideoTracks()[0];
  const audioTrack = cameraStream?.getAudioTracks()[0];
  const deviceStatus = (track: MediaStreamTrack | undefined) =>
    track
      ? { done: true, text: track.label || "Connected" }
      : cameraStatus === "error"
        ? { done: false, failed: true, text: "Not available" }
        : { done: false, text: "Waiting for access…" };
  const devices: {
    name: string;
    done: boolean;
    failed?: boolean;
    text: string;
    aside?: ReactNode;
  }[] = [
    ...(willRecord
      ? [
          { name: "Camera", ...deviceStatus(videoTrack) },
          {
            name: "Microphone",
            ...deviceStatus(audioTrack),
            aside: cameraStream && audioTrack && checkAudio && (
              <MicLevel stream={cameraStream} context={checkAudio} />
            ),
          },
        ]
      : []),
    {
      name: "Speakers",
      done: speaker.found,
      text: speaker.label,
      aside: (
        <button type="button" className="speaker-test" onClick={testSpeakers}>
          {"Test"}
        </button>
      ),
    },
  ];

  const startLabel = directing
    ? "Directing the scene…"
    : !cameraReady
      ? "Waiting for your camera and microphone"
      : `${
          linesReady
            ? "Start rehearsal"
            : linesStartable
              ? "Start anyway"
              : "Preparing your scene partner’s lines"
        }${pregen.total > 0 ? ` · ${pregen.ready} of ${pregen.total}` : ""}`;

  return (
    <SetupStep
      step={4}
      scriptName={scriptName}
      onGoToStep={onGoToStep}
    >
      <div className="role-intro">
        <h1>Ready to rehearse?</h1>
      </div>
      <p className="processing-explanation">
        {willRecord
          ? "We’ll record a self-tape while you run the scene — or run your lines first without recording. Check your framing while your scene partners get ready."
          : "Sit back and listen to the full scene while your scene partners get ready."}
      </p>

      {willRecord && (
        <div className="rehearsal-setup-camera">
          <div className="self-tape-video">
            {cameraStream ? (
              <video
                className="self-tape-preview"
                ref={previewRef}
                muted
                autoPlay
                playsInline
              />
            ) : (
              <div className="self-tape-placeholder">
                {cameraStatus === "error"
                  ? "Camera not available"
                  : "Waiting for camera access…"}
              </div>
            )}
            {cameraStream && isIpad() && (
              <p className="self-tape-hint">
                Tip: turn off Center Stage in Control Center for steady framing.
              </p>
            )}
          </div>
        </div>
      )}
      <ul className="rehearsal-setup-devices" aria-label="Your devices">
        {devices.map((device) => (
          <li
            key={device.name}
            className={
              device.done ? "is-complete" : device.failed ? "is-failed" : undefined
            }
          >
            <span aria-hidden="true">
              {device.done ? "✓" : device.failed ? "✕" : "○"}
            </span>
            <strong>{device.name}</strong>
            <small title={device.text}>{device.text}</small>
            {device.aside}
          </li>
        ))}
      </ul>
      {willRecord && cameraStatus === "error" && (
        <div className="device-problem" role="alert">
          <p>{cameraError}</p>
          <button type="button" className="speaker-test" onClick={onRetryCamera}>
            Try again
          </button>
        </div>
      )}
      {willRecord && permissionSlow && (
        <div className="device-problem" role="status">
          <p>
            Look for your browser’s permission prompt near the address bar and
            choose Allow for the camera and microphone.
          </p>
          <button type="button" className="speaker-test" onClick={onRetryCamera}>
            Ask again
          </button>
        </div>
      )}

      {/* The progress bar is the start button: disabled until enough lines
          are ready (or it's been a while, or some failed, when it offers
          Start anyway) and the camera is on. */}
      <button
        type="button"
        className={`preparing-progress ${canStart ? "is-ready" : ""}`}
        disabled={!canStart}
        onClick={onStart}
      >
        <i
          aria-hidden="true"
          style={{
            width: `${pregen.total ? (pregen.ready / pregen.total) * 100 : pregen.done ? 100 : 0}%`,
          }}
        />
        <span role="status">{startLabel}</span>
      </button>
      {/* Back, and a run without the tape, beside the start button's row. */}
      <div className="rehearsal-setup-actions">
        <button type="button" className="btn-secondary" onClick={onBack}>
          Back
        </button>
        {onPracticeRun && (
          <button
            type="button"
            className="btn-secondary"
            disabled={!linesStartable}
            onClick={onPracticeRun}
          >
            Just run lines
          </button>
        )}
      </div>
      {/* Every line loaded: nothing left to explain. */}
      {!allLinesReady && (
        <div className="preparing-note">
          <p>
            {pregen.failed > 0
              ? "Some lines couldn’t be pre-loaded; they’ll load as you go."
              : linesReady
                ? "The rest keep loading while you rehearse."
                : "You can start once enough lines are ready."}
          </p>
        </div>
      )}
    </SetupStep>
  );
}
