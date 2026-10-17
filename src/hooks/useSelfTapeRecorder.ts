import { useEffect, useRef, useState } from "react";
import { logAudioEvent } from "../lib/audioDiagnostics";
import { resolvePreferredDevice, setPreferredDevice, type DeviceChoice } from "../lib/mediaDevices";

type RecorderStatus = "idle" | "requesting" | "ready" | "recording" | "paused" | "error";

// First entry the browser actually supports wins. mp4 only: it's the one
// container iOS can play back, save to Photos, and share. Browsers with no
// mp4 encoder (Firefox) support neither of these, so isTypeSupported() fails
// for both and MediaRecorder falls back to that browser's own implicit
// default (webm) — same outcome as explicitly listing webm, minus the dead
// entries here.
const MIME_TYPES = ["video/mp4;codecs=avc1,mp4a", "video/mp4"];

function pickMimeType(): string | undefined {
  return MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

// Not in lib.dom's MediaTrackCapabilities/Constraints yet — `zoom` is part of
// the Image Capture extensions, supported only on some browsers/devices.
type ZoomCapabilities = MediaTrackCapabilities & { zoom?: { min: number; max: number } };

/**
 * Narrows an ultra-wide front camera's field of view toward a normal
 * self-tape framing, where the browser exposes a zoom control at all. Purely
 * best-effort: many browsers lack getCapabilities() or the zoom constraint,
 * and a failure here must never block recording.
 */
async function applyFrontCameraZoom(track: MediaStreamTrack): Promise<void> {
  try {
    if (typeof track.getCapabilities !== "function") return;
    const zoom = (track.getCapabilities() as ZoomCapabilities).zoom;
    if (!zoom) return;
    const target = Math.min(Math.max(1.5, zoom.min), zoom.max);
    await track.applyConstraints({
      advanced: [{ zoom: target } as MediaTrackConstraintSet],
    });
    logAudioEvent("camera", `zoom applied: ${target} (range ${zoom.min}-${zoom.max})`);
  } catch (err) {
    logAudioEvent("camera", `zoom not applied: ${err}`);
  }
}

/** iPadOS 13+ Safari reports a desktop Mac user agent by default, so "iPad"
 * alone misses most real iPads — a touch-capable "Mac" is the tell. */
export function isIpad(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    navigator.userAgent.includes("iPad") ||
    (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1)
  );
}

/**
 * Camera + mic capture for rehearsal self-tapes, split into two steps so the
 * camera can be live (and previewed) during the start countdown while actual
 * capture only begins once it ends:
 *
 * `requestCamera()` opens the camera and exposes the live `stream` for a
 * preview <video>. `startRecording(ttsStream, sharedContext)` begins
 * capturing from that stream; if `ttsStream` is given (the scene partner's
 * TTS audio, tapped directly rather than picked up acoustically off the mic
 * — see useTtsPlayer's getTapStream), it's mixed with the mic track into the
 * recording's single audio track using `sharedContext` — the caller's own
 * AudioContext (from useTtsPlayer), not one of our own. Sharing it means
 * there's a single context for the whole rehearsal to keep resumed on
 * mobile, rather than a second one liable to start (or end up) suspended
 * this deep into an async chain, silently recording with no audio.
 * `pause()`/`resume()` pause and resume capture without releasing the
 * camera. `stop()` resolves with the finished recording as a Blob and
 * releases the camera. Permission failures land in `error` rather than
 * throwing.
 */
/** What went wrong opening the camera and mic, and how the actor fixes it.
 * A blocked site never gets a permission prompt again, so retrying alone
 * can't help there: they have to allow it in the browser first. */
export function cameraErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Your browser is blocking the camera and microphone for this site. Click the camera or site-settings icon in the address bar, allow both, then try again.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "We couldn't find a camera and microphone. Connect them, then try again.";
    case "NotReadableError":
    case "AbortError":
      return "Your camera or microphone is in use by another app. Close it (Zoom, FaceTime, another tab), then try again.";
    default:
      return "We couldn't access your camera and microphone. Check your browser permissions, then try again.";
  }
}

/** Opens the camera and mic, the chosen ones where the actor picked them
 * (`exact`, so a missing device fails rather than silently swapping in
 * another), otherwise the front camera and the default mic. */
function openCameraAndMic(cameraId: string | null, micId: string | null): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    // `video: true` lets iPad Safari hand back its native front-camera
    // format, which on ultra-wide front cameras records a distorted,
    // wide-FOV tape instead of a standard 16:9 self-tape frame. The size
    // hints are all `ideal`, never `exact`: a device that can't match falls
    // back to its closest format rather than failing getUserMedia outright.
    video: {
      ...(cameraId ? { deviceId: { exact: cameraId } } : { facingMode: "user" }),
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      aspectRatio: { ideal: 16 / 9 },
    },
    // The same mic feeds the tape and live line tracking
    // (useScribeTracking.ts) while the scene partner plays out of the
    // speaker. Echo cancellation keeps that playback out of both: the
    // tape mixes the partner in directly, and Scribe shouldn't transcribe
    // it. Noise suppression and auto gain stay at the browser's defaults
    // — forcing them on would flatten the actor's dynamics on the tape.
    audio: {
      echoCancellation: true,
      ...(micId ? { deviceId: { exact: micId } } : {}),
    },
  });
}

export function useSelfTapeRecorder() {
  const [status, setStatus] = useState<RecorderStatus>("idle");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const mixNodesRef = useRef<AudioNode[]>([]);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  // iOS mutes the camera track whenever something else takes the camera
  // over mid-take (a call, Control Center, a notification, overheating).
  // MediaRecorder keeps writing the mixed audio regardless, so without this
  // the tape comes out with a frozen picture over continuing sound.
  const [cameraInterrupted, setCameraInterrupted] = useState(false);
  const unwatchCameraRef = useRef<(() => void) | null>(null);

  const disconnectMix = () => {
    mixNodesRef.current.forEach((node) => node.disconnect());
    mixNodesRef.current = [];
  };

  useEffect(() => {
    const cleanup = () => {
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop();
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
      disconnectMix();
      unwatchCameraRef.current?.();
    };
    return cleanup;
  }, []);

  const requestCamera = async ({ releaseFirst = false } = {}) => {
    setError(null);
    setStatus("requesting");
    // Switching devices: some cameras (and iOS) can't be open twice, so the
    // old one goes before the new one is asked for.
    if (releaseFirst) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    const cameraId = await resolvePreferredDevice("videoinput");
    const micId = await resolvePreferredDevice("audioinput");
    let media: MediaStream;
    try {
      media = await openCameraAndMic(cameraId, micId).catch((err) => {
        // A remembered device that's since been unplugged: forget it and
        // take the browser's default rather than failing the whole step.
        const missing =
          err instanceof DOMException &&
          (err.name === "OverconstrainedError" || err.name === "NotFoundError");
        if (!missing || (!cameraId && !micId)) throw err;
        logAudioEvent("camera", "remembered device missing; using defaults");
        setPreferredDevice("videoinput", null);
        setPreferredDevice("audioinput", null);
        return openCameraAndMic(null, null);
      });
    } catch (err) {
      console.error("Self-tape camera unavailable:", err);
      setStatus("error");
      setError(cameraErrorMessage(err));
      return;
    }
    const videoTrack = media.getVideoTracks()[0];
    if (videoTrack) {
      // Constraints are only hints, so log what the camera actually gave us —
      // the only way to tell from a beta report whether a wide tape came from
      // the browser ignoring the constraints or from something downstream.
      const settings = videoTrack.getSettings();
      logAudioEvent(
        "camera",
        `opened ${settings.width}x${settings.height}, aspectRatio=${settings.aspectRatio?.toFixed(3) ?? "?"}, facingMode=${settings.facingMode ?? "?"}`,
      );
      await applyFrontCameraZoom(videoTrack);
    }
    const audioTrack = media.getAudioTracks()[0];
    if (audioTrack) {
      // Like the camera's, these are only hints: log what the browser applied.
      const settings = audioTrack.getSettings();
      logAudioEvent(
        "mic",
        `opened echoCancellation=${settings.echoCancellation ?? "?"}, noiseSuppression=${settings.noiseSuppression ?? "?"}, autoGainControl=${settings.autoGainControl ?? "?"}`,
      );
    }
    // Asked again (Try again, or StrictMode's double mount): one camera at a time.
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = media;
    setStream(media);
    setStatus("ready");
  };

  /** Picks a different camera or mic on the setup step (null: the
   * browser's default) and reopens the stream with it. Never mid-take: the
   * recorder holds the current tracks. */
  const switchDevice = async (kind: "videoinput" | "audioinput", choice: DeviceChoice | null) => {
    if (recorderRef.current) return;
    setPreferredDevice(kind, choice);
    await requestCamera({ releaseFirst: true });
  };

  const startRecording = (ttsStream?: MediaStream | null, sharedContext?: AudioContext | null) => {
    const media = streamRef.current;
    if (!media || recorderRef.current) return;

    // Mix the mic with the TTS tap so the recording gets the scene partner's
    // lines directly, not whatever the mic happens to pick up off the
    // speakers. Falls back to mic-only if no tap stream (or shared context)
    // was available.
    let recordingStream = media;
    const micTrack = media.getAudioTracks()[0];
    if (ttsStream?.getAudioTracks().length && micTrack && sharedContext) {
      logAudioEvent("recorder", `mixing into shared ctx, state=${sharedContext.state}`);
      // Defensive, not load-bearing: the caller's own Start-click handler
      // already resumes this same context before the countdown even runs.
      void sharedContext.resume();
      const destination = sharedContext.createMediaStreamDestination();
      const micSource = sharedContext.createMediaStreamSource(media);
      const ttsSource = sharedContext.createMediaStreamSource(ttsStream);
      micSource.connect(destination);
      ttsSource.connect(destination);
      mixNodesRef.current = [micSource, ttsSource, destination];
      recordingStream = new MediaStream([
        media.getVideoTracks()[0],
        destination.stream.getAudioTracks()[0],
      ]);
    }
    recordingStreamRef.current = recordingStream;

    const videoTrack = media.getVideoTracks()[0];
    if (videoTrack) {
      const onMute = () => {
        logAudioEvent("camera", "video track muted mid-take");
        setCameraInterrupted(true);
      };
      const onUnmute = () => {
        logAudioEvent("camera", "video track unmuted");
        setCameraInterrupted(false);
      };
      const onEnded = () => {
        logAudioEvent("camera", "video track ended mid-take");
        setCameraInterrupted(true);
      };
      videoTrack.addEventListener("mute", onMute);
      videoTrack.addEventListener("unmute", onUnmute);
      videoTrack.addEventListener("ended", onEnded);
      unwatchCameraRef.current = () => {
        videoTrack.removeEventListener("mute", onMute);
        videoTrack.removeEventListener("unmute", onUnmute);
        videoTrack.removeEventListener("ended", onEnded);
        unwatchCameraRef.current = null;
      };
    }

    chunksRef.current = [];
    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(recordingStream, mimeType ? { mimeType } : undefined);
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onerror = (event) => {
      logAudioEvent("recorder", `MediaRecorder error: ${(event as ErrorEvent).error ?? event.type}`);
    };
    recorderRef.current = recorder;
    // A one-second timeslice hands the take over as it records instead of
    // all at once on stop(), so a recorder that dies mid-take still leaves
    // everything up to that point. Safari 26 returns empty chunks for
    // timeslices of ~100ms or less; a second is safely clear of that.
    recorder.start(1000);
    logAudioEvent("recorder", `MediaRecorder.start() called, mimeType=${mimeType ?? "(default)"}`);
    setStatus("recording");
  };

  // Idempotent — safe to call regardless of current state, so callers don't
  // need to track whether a change is actually a transition.
  const pause = () => {
    if (recorderRef.current?.state === "recording") {
      recorderRef.current.pause();
      setStatus("paused");
    }
  };

  const resume = () => {
    if (recorderRef.current?.state === "paused") {
      recorderRef.current.resume();
      setStatus("recording");
    }
  };

  const stop = async (): Promise<Blob | null> => {
    const recorder = recorderRef.current;
    let blob: Blob | null = null;
    if (recorder && recorder.state !== "inactive") {
      blob = await new Promise<Blob>((resolve) => {
        recorder.onstop = () =>
          resolve(new Blob(chunksRef.current, { type: recorder.mimeType }));
        recorder.stop();
      });
    } else if (recorder && chunksRef.current.length > 0) {
      // The recorder already stopped itself (an error, or the camera ending
      // under it) — keep whatever it captured before that.
      logAudioEvent("recorder", "recorder was already inactive; saving the chunks it left");
      blob = new Blob(chunksRef.current, { type: recorder.mimeType });
    }

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
    recordingStreamRef.current = null;
    disconnectMix();
    unwatchCameraRef.current?.();
    setCameraInterrupted(false);
    recorderRef.current = null;
    chunksRef.current = [];
    setStream(null);
    setStatus("idle");
    return blob;
  };

  return { status, stream, error, cameraInterrupted, requestCamera, switchDevice, startRecording, pause, resume, stop };
}
