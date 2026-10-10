import { useEffect, useRef, useState } from "react";
import type { ReaderAudioPregenState } from "../../hooks/useReaderAudioPregen";
import {
  describeVoice,
  displayCharacterName,
  voiceDisplayName,
  type Voice,
} from "../../lib/script";
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
  cast,
  pregen,
  willRecord,
  cameraStatus,
  cameraStream,
  cameraError,
  onRetryCamera,
  signedIn,
  scriptSaved,
  onStart,
}: {
  scriptName: string;
  /** Back to an earlier step (1-based), from the header's step bars. */
  onGoToStep?: (step: number) => void;
  /** The scene partners and the voices cast for them on step 3. */
  cast: { speaker: string; voice: Voice | null }[];
  pregen: ReaderAudioPregenState;
  /** Reading a role: there's a self-tape, so a camera to set up. */
  willRecord: boolean;
  cameraStatus: RecorderStatus;
  cameraStream: MediaStream | null;
  cameraError: string | null;
  onRetryCamera: () => void;
  /** Recording saves to the account, so it needs one. */
  signedIn: boolean;
  /** The take is saved under the script's record, so it must exist. */
  scriptSaved: boolean;
  onStart: () => void;
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
    linesStartable && cameraReady && (!willRecord || (signedIn && scriptSaved));
  const directing =
    pregen.waitingForDirection || (pregen.total === 0 && !pregen.done);

  const videoTrack = cameraStream?.getVideoTracks()[0];
  const audioTrack = cameraStream?.getAudioTracks()[0];
  const deviceStatus = (track: MediaStreamTrack | undefined) =>
    track
      ? { done: true, text: track.label || "Connected" }
      : cameraStatus === "error"
        ? { done: false, text: "Not available" }
        : { done: false, text: "Waiting for access…" };
  const devices = [
    { name: "Camera", ...deviceStatus(videoTrack) },
    { name: "Microphone", ...deviceStatus(audioTrack) },
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
      title="Get ready"
      scriptName={scriptName}
      onGoToStep={onGoToStep}
    >
      <div className="role-intro">
        <h1>Ready to rehearse?</h1>
      </div>
      <p className="processing-explanation">
        {willRecord
          ? "We’ll record a self-tape while you run the scene. Check your framing while your scene partners get ready."
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
                  ? cameraError
                  : "Waiting for camera access…"}
              </div>
            )}
            {cameraStream && isIpad() && (
              <p className="self-tape-hint">
                Tip: turn off Center Stage in Control Center for steady
                framing.
              </p>
            )}
          </div>
        </div>
      )}
      {willRecord && (
        <ul
          className="rehearsal-setup-devices"
          aria-label="Your camera and microphone"
        >
          {devices.map((device) => (
            <li
              key={device.name}
              className={device.done ? "is-complete" : undefined}
            >
              <span aria-hidden="true">{device.done ? "✓" : "○"}</span>
              <strong>{device.name}</strong>
              <small title={device.text}>{device.text}</small>
            </li>
          ))}
        </ul>
      )}
      {willRecord && cameraStatus === "error" && (
        <button
          type="button"
          className="script-accordion-toggle"
          onClick={onRetryCamera}
        >
          Try camera again
        </button>
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
      {/* Every line loaded: nothing left to explain. */}
      {(!allLinesReady || (willRecord && !signedIn)) && (
        <div className="preparing-note">
          <p>
            {willRecord && !signedIn
              ? "Sign in to rehearse."
              : pregen.failed > 0
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
