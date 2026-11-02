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

const BACKGROUND_MESSAGE =
  "Your camera and microphone turned off while the app was in the background. Tap Try again to turn them back on.";

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
 * (NativeMediaPlugin) instead of getUserMedia and MediaRecorder.
 *
 * This hook is the only owner of the camera and mic. It holds at most one
 * capture lease: taken by requestCamera (step 4 opening, Try again, a device
 * switch — the new lease is taken before the old one is returned, so the
 * hardware doesn't flicker off), returned by stop() and on unmount. Line
 * tracking reads the mic natively while the lease is held but never takes
 * one itself.
 *
 * The preview is drawn natively (NativeCameraPreview) and the take — mic and
 * scene partner mixed by the native engine — is written straight to an .mp4
 * file, so `stream` is always null and `stop()` resolves with that file.
 *
 * If the app goes to the background, the native side releases everything
 * itself, finishing a take in progress. That take is handed back by the
 * next stop(), and `endedInBackground` tells the rehearsal to end the take.
 */
export function useNativeSelfTapeRecorder() {
  const [status, setStatus] = useState<RecorderStatus>("idle");
  const [zoom, setZoomState] = useState<{ range: ZoomRange; value: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cameraInterrupted, setCameraInterrupted] = useState(false);
  const [videoSize, setVideoSize] = useState<{ width: number; height: number } | null>(null);
  const [endedInBackground, setEndedInBackground] = useState(false);
  const leaseRef = useRef<number | null>(null);
  const recordingRef = useRef(false);
  const unmountedRef = useRef(false);
  /** Bumped by every requestCamera/stop, so a slow acquire that's been
   * superseded hands its lease straight back. */
  const generationRef = useRef(0);
  /** A take the native side finished on its own (backgrounding). */
  const pendingTakeRef = useRef<RecordedTake | null>(null);

  const releaseLease = (reason: string) => {
    const leaseId = leaseRef.current;
    leaseRef.current = null;
    if (leaseId !== null) return NativeMedia.releaseCapture({ leaseId, reason });
    return Promise.resolve();
  };

  useEffect(() => {
    unmountedRef.current = false;
    const interrupted = NativeMedia.addListener("cameraInterrupted", ({ interrupted }) => {
      logAudioEvent("camera", interrupted ? "camera interrupted mid-take" : "camera back");
      if (recordingRef.current) setCameraInterrupted(interrupted);
    });
    const released = NativeMedia.addListener("mediaReleased", ({ take }) => {
      // The native side already let everything go; just forget the lease.
      leaseRef.current = null;
      generationRef.current += 1;
      if (recordingRef.current) {
        recordingRef.current = false;
        pendingTakeRef.current = take ?? null;
        setEndedInBackground(true);
        setStatus("idle");
        return;
      }
      setStatus("error");
      setError(BACKGROUND_MESSAGE);
    });
    return () => {
      unmountedRef.current = true;
      generationRef.current += 1;
      void interrupted.then((handle) => handle.remove());
      void released.then((handle) => handle.remove());
      const wasRecording = recordingRef.current;
      recordingRef.current = false;
      // Leaving mid-take: the file is dropped (Rehearsal finishes takes
      // through stop() before it unmounts), then the camera and mic go.
      void (wasRecording ? NativeMedia.stopRecording().catch(() => {}) : Promise.resolve()).then(() =>
        releaseLease("recorder unmounted"),
      );
    };
  }, []);

  const requestCamera = async () => {
    setError(null);
    setStatus("requesting");
    setZoomState(null);
    setEndedInBackground(false);
    const generation = ++generationRef.current;
    const previousLease = leaseRef.current;
    try {
      // A remembered camera that's gone falls back to the front camera natively.
      const { leaseId, camera } = await NativeMedia.acquireCapture({
        reason: "self-tape camera and mic",
        camera: true,
        micId: preferredDevice("audioinput")?.id || null,
        cameraId: preferredDevice("videoinput")?.id || null,
        zoom: preferredZoom() ?? (isIpad() ? 1.5 : 1),
      });
      if (generation !== generationRef.current || unmountedRef.current) {
        void NativeMedia.releaseCapture({ leaseId, reason: "superseded before it was used" });
        return;
      }
      leaseRef.current = leaseId;
      // The new lease is live; now the old one can go without the hardware
      // ever turning off in between.
      if (previousLease !== null) {
        void NativeMedia.releaseCapture({ leaseId: previousLease, reason: "replaced by a new lease" });
      }
      if (camera) {
        logAudioEvent("camera", `opened natively ${camera.width}x${camera.height}, zoom ${camera.zoom}`);
        setVideoSize({ width: camera.width, height: camera.height });
        setZoomState(camera.zoomRange ? { range: { ...camera.zoomRange, step: 0.1 }, value: camera.zoom } : null);
      }
      setStatus("ready");
    } catch (err) {
      if (generation !== generationRef.current) return;
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
    await requestCamera();
  };

  // The scene partner is mixed natively, so the web player's tap stream and
  // context (passed on the web) aren't needed here.
  const startRecording = () => {
    if (leaseRef.current === null || recordingRef.current) return;
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

  /** Finishes the take, returns the camera and mic, and resolves with the
   * take's file (in the temp folder until kept), or null if nothing was
   * recorded. */
  const stop = async (): Promise<RecordedTake | null> => {
    generationRef.current += 1;
    let take: RecordedTake | null = pendingTakeRef.current;
    pendingTakeRef.current = null;
    if (recordingRef.current) {
      recordingRef.current = false;
      const result = await NativeMedia.stopRecording();
      if (result.path) take = result as RecordedTake;
      logAudioEvent("recorder", take ? `native take written, ${take.size} bytes` : "native take was empty");
    }
    await releaseLease("take finished");
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
    endedInBackground,
  };
}
