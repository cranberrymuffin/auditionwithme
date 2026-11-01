import { useEffect, useRef, useState } from "react";
import { logAudioEvent } from "../lib/audioDiagnostics";
import {
  isIpad,
  preferredDevice,
  preferredZoom,
  setPreferredDevice,
  setPreferredZoom,
  type DeviceChoice,
} from "../lib/mediaDevices";
import { NativeMedia, type RecordedTake } from "../lib/native/nativeMedia";

type RecorderStatus = "idle" | "requesting" | "ready" | "recording" | "paused" | "error";
type ZoomRange = { min: number; max: number; step: number };

/** What went wrong opening the camera or mic in the app, and how to fix it.
 * iOS asks once; after a "Don't Allow" only Settings can change it. */
function nativeCameraErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("NotAllowedError")) {
    return "Audition With Me doesn't have access to your camera or microphone. Turn both on in Settings → Apps → Audition With Me, then try again.";
  }
  if (message.includes("No camera")) return "We couldn't find a camera on this device.";
  return "We couldn't open your camera and microphone. Close any other app using them, then try again.";
}

/**
 * useSelfTapeRecorder in the iOS app: the phone's own camera and mic
 * (NativeMediaPlugin) instead of getUserMedia and MediaRecorder. The preview
 * is drawn natively (NativeCameraPreview), the mic feeds line tracking
 * natively, and the take — mic and scene partner mixed by the native audio
 * engine — is written straight to an .mp4 file, so `stream` is always null
 * and `stop()` resolves with that file instead of a Blob.
 */
export function useNativeSelfTapeRecorder() {
  const [status, setStatus] = useState<RecorderStatus>("idle");
  const [zoom, setZoomState] = useState<{ range: ZoomRange; value: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cameraInterrupted, setCameraInterrupted] = useState(false);
  const [videoSize, setVideoSize] = useState<{ width: number; height: number } | null>(null);
  const recordingRef = useRef(false);
  const openRef = useRef(false);

  useEffect(() => {
    const listener = NativeMedia.addListener("cameraInterrupted", ({ interrupted }) => {
      logAudioEvent("camera", interrupted ? "camera interrupted mid-take" : "camera back");
      if (recordingRef.current) setCameraInterrupted(interrupted);
    });
    return () => {
      void listener.then((handle) => handle.remove());
      if (recordingRef.current) void NativeMedia.stopRecording();
      if (openRef.current) {
        void NativeMedia.closeCamera();
        void NativeMedia.stopMic();
      }
    };
  }, []);

  const requestCamera = async () => {
    setError(null);
    setStatus("requesting");
    setZoomState(null);
    try {
      // A remembered camera that's gone falls back to the front camera natively.
      const camera = await NativeMedia.openCamera({
        cameraId: preferredDevice("videoinput")?.id ?? null,
        zoom: preferredZoom() ?? (isIpad() ? 1.5 : 1),
      });
      await NativeMedia.startMic({ micId: preferredDevice("audioinput")?.id ?? null });
      openRef.current = true;
      logAudioEvent("camera", `opened natively ${camera.width}x${camera.height}, zoom ${camera.zoom}`);
      setVideoSize({ width: camera.width, height: camera.height });
      setZoomState(
        camera.zoomRange ? { range: { ...camera.zoomRange, step: 0.1 }, value: camera.zoom } : null,
      );
      setStatus("ready");
    } catch (err) {
      console.error("Native camera unavailable:", err);
      setStatus("error");
      setError(nativeCameraErrorMessage(err));
    }
  };

  /** Zooms the live camera and remembers the level; setup step only. */
  const setZoom = (value: number) => {
    if (!zoom) return;
    const next = Math.min(Math.max(value, zoom.range.min), zoom.range.max);
    setZoomState({ ...zoom, value: next });
    setPreferredZoom(next);
    void NativeMedia.setZoom({ zoom: next });
  };

  /** A different camera or mic on the setup step; never mid-take. */
  const switchDevice = async (kind: "videoinput" | "audioinput", choice: DeviceChoice | null) => {
    if (recordingRef.current) return;
    setPreferredDevice(kind, choice);
    if (kind === "audioinput") {
      await NativeMedia.startMic({ micId: choice?.id ?? null });
      return;
    }
    await requestCamera();
  };

  // The scene partner is mixed natively, so the web player's tap stream and
  // context (passed on the web) aren't needed here.
  const startRecording = () => {
    if (!openRef.current || recordingRef.current) return;
    recordingRef.current = true;
    void NativeMedia.startRecording().then(
      () => logAudioEvent("recorder", "native recording started"),
      (err) => logAudioEvent("recorder", `native recording failed to start: ${err}`),
    );
    setStatus("recording");
  };

  const pause = () => {
    if (status !== "recording") return;
    void NativeMedia.pauseRecording();
    setStatus("paused");
  };

  const resume = () => {
    if (status !== "paused") return;
    void NativeMedia.resumeRecording();
    setStatus("recording");
  };

  /** Stops, releases the camera and mic, and resolves with the take's
   * file (in the temp folder until kept), or null if nothing was recorded. */
  const stop = async (): Promise<RecordedTake | null> => {
    let take: RecordedTake | null = null;
    if (recordingRef.current) {
      const result = await NativeMedia.stopRecording();
      if (result.path) take = result as RecordedTake;
      logAudioEvent("recorder", take ? `native take written, ${take.size} bytes` : "native take was empty");
    }
    recordingRef.current = false;
    if (openRef.current) {
      openRef.current = false;
      await NativeMedia.closeCamera();
      await NativeMedia.stopMic();
    }
    setCameraInterrupted(false);
    setZoomState(null);
    setStatus("idle");
    return take;
  };

  return {
    status,
    stream: null as MediaStream | null,
    error,
    cameraInterrupted,
    zoom,
    setZoom,
    requestCamera,
    switchDevice,
    startRecording,
    pause,
    resume,
    stop,
    videoSize,
    nativePreview: true,
  };
}
