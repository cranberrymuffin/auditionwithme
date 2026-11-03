import { useEffect, useRef, useState } from "react";
import { isIpad } from "../../hooks/useSelfTapeRecorder";
import NativeCameraPreview from "./NativeCameraPreview";

type RecorderStatus = "idle" | "requesting" | "ready" | "recording" | "paused" | "error";

function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export default function SelfTapeRecorder({
  status,
  stream,
  error,
  saving,
  paused,
  practiceRun,
  onTogglePause,
  onStop,
  nativePreview = false,
  onRetry,
}: {
  status: RecorderStatus;
  stream: MediaStream | null;
  error: string | null;
  saving: boolean;
  /** Rehearsal-wide pause state — mirrors the recorder's own paused status. */
  paused: boolean;
  /** Running lines without recording: the camera only mirrors the actor. */
  practiceRun: boolean;
  onTogglePause: () => void;
  onStop: () => void;
  /** iOS app: the camera is drawn natively, and there's no stream. */
  nativePreview?: boolean;
  /** Offered with an error: turns the camera and mic back on (the iOS app,
   * after backgrounding turned them off). */
  onRetry?: () => void;
}) {
  const previewRef = useRef<HTMLVideoElement | null>(null);
  // Seconds of tape so far; holds still while paused.
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (previewRef.current) previewRef.current.srcObject = stream;
  }, [stream]);

  useEffect(() => {
    if (status !== "recording") return;
    const timer = setInterval(() => setElapsed((seconds) => seconds + 1), 1000);
    return () => clearInterval(timer);
  }, [status]);

  const isRecording = status === "recording" || status === "paused";
  // In the iOS app there's no stream: the camera is on from ready onward.
  const cameraOn = Boolean(stream) || (nativePreview && (status === "ready" || isRecording));
  // Center Stage digitally pans/zooms the front camera to follow the face,
  // overriding our framing constraints; it can only be turned off by the
  // user (Control Center), so tell iPad users before they start a take.
  const showCenterStageHint = cameraOn && !isRecording && !practiceRun && isIpad();

  return (
    <div className={`self-tape-setting ${practiceRun ? "is-practice" : ""}`}>
      <div className={`self-tape-video ${nativePreview ? "is-native-preview" : ""}`}>
        {nativePreview && cameraOn ? (
          <NativeCameraPreview className="self-tape-preview" />
        ) : stream ? (
          <video className="self-tape-preview" ref={previewRef} muted autoPlay playsInline />
        ) : (
          <div className={`self-tape-placeholder ${status === "error" && onRetry ? "has-retry" : ""}`}>
            {status === "requesting" ? "Waiting for camera access…" : error ?? "Camera preview"}
            {status === "error" && onRetry && (
              <button type="button" className="speaker-test" onClick={onRetry}>
                Try again
              </button>
            )}
          </div>
        )}
        {showCenterStageHint && (
          <p className="self-tape-hint">
            Tip: turn off Center Stage in Control Center for steady framing.
          </p>
        )}
        {isRecording && (
          <span className={`self-tape-rec ${status === "paused" ? "is-paused" : ""}`}>
            <i aria-hidden="true" />
            {status === "paused" ? "Paused" : "Rec"}
            <time aria-label={`${formatElapsed(elapsed)} recorded`}>{formatElapsed(elapsed)}</time>
          </span>
        )}
        {practiceRun && cameraOn && (
          <span className="self-tape-rec is-practice">Practice run · not recording</span>
        )}
      </div>
      {isRecording && (
        <div className="self-tape-controls">
          <button type="button" onClick={onTogglePause} aria-pressed={paused}>
            <span aria-hidden="true">{paused ? "▶︎" : "❚❚"}</span>
            {paused ? "Resume" : "Pause"}
          </button>
          <button
            type="button"
            className="self-tape-end"
            onClick={onStop}
            disabled={saving}
          >
            <span aria-hidden="true">■</span>
            {saving ? "Saving…" : "End take"}
          </button>
        </div>
      )}
    </div>
  );
}
