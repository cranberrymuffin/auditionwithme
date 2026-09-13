import { useEffect, useRef } from "react";

type RecorderStatus = "idle" | "requesting" | "ready" | "recording" | "paused" | "error";

export default function SelfTapeRecorder({
  status,
  stream,
  error,
  saving,
  paused,
  onTogglePause,
  onStop,
}: {
  status: RecorderStatus;
  stream: MediaStream | null;
  error: string | null;
  saving: boolean;
  /** Rehearsal-wide pause state — mirrors the recorder's own paused status. */
  paused: boolean;
  onTogglePause: () => void;
  onStop: () => void;
}) {
  const previewRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (previewRef.current) previewRef.current.srcObject = stream;
  }, [stream]);

  const isRecording = status === "recording" || status === "paused";

  return (
    <div className="self-tape-setting">
      <div className="self-tape-video">
        {stream ? (
          <video className="self-tape-preview" ref={previewRef} muted autoPlay playsInline />
        ) : (
          <div className="self-tape-placeholder">
            {status === "requesting" ? "Waiting for camera access…" : error ?? "Camera preview"}
          </div>
        )}
        {isRecording && (
          <span className={`self-tape-rec ${status === "paused" ? "is-paused" : ""}`}>
            <i aria-hidden="true" />
            {status === "paused" ? "Paused" : "Rec"}
          </span>
        )}
        {isRecording && (
          <div className="self-tape-video-controls">
            <button
              type="button"
              onClick={onTogglePause}
              aria-label={paused ? "Resume recording" : "Pause recording"}
            >
              {paused ? "▶" : "❚❚"}
            </button>
            <button
              type="button"
              onClick={onStop}
              disabled={saving}
              aria-label="Stop recording"
            >
              ■
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
