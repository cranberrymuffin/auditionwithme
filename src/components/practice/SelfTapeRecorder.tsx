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
  practiceRun,
  nativePreview = false,
  onRetry,
}: {
  status: RecorderStatus;
  stream: MediaStream | null;
  error: string | null;
  /** Running lines without recording: the camera only mirrors the actor. */
  practiceRun: boolean;
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
              <button type="button" className="btn-secondary" onClick={onRetry}>
                Try again
              </button>
            )}
          </div>
        )}
      </div>
      {/* Beside or under the picture, never over it: the iOS app draws the
          camera as a native layer above the page, which would hide them. */}
      <div className="self-tape-info">
        {isRecording && (
          <p className={`self-tape-rec ${status === "paused" ? "is-paused" : ""}`}>
            <span>
              <i aria-hidden="true" />
              {status === "paused" ? "Paused" : "Rec"}
            </span>
            <time aria-label={`${formatElapsed(elapsed)} recorded`}>{formatElapsed(elapsed)}</time>
          </p>
        )}
        {practiceRun && cameraOn && (
          <p className="self-tape-rec is-practice">
            <span>Practice run</span> <small>Not recording</small>
          </p>
        )}
        {showCenterStageHint && (
          <p className="field-hint self-tape-hint">
            Tip: turn off Center Stage in Control Center for steady framing.
          </p>
        )}
      </div>
    </div>
  );
}
