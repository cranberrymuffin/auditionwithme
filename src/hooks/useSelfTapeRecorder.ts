import { useEffect, useRef, useState } from "react";
import { logAudioEvent } from "../lib/audioDiagnostics";
import { pickSupportedType, stemMimeCandidates, type TapeStems } from "../lib/tapeRemix";

type RecorderStatus = "idle" | "requesting" | "ready" | "recording" | "paused" | "error";

// First entry the browser actually supports wins. mp4 only: it's the one
// container iOS can play back, save to Photos, and share. Browsers with no
// mp4 encoder (Firefox) support neither of these, so isTypeSupported() fails
// for both and MediaRecorder falls back to that browser's own implicit
// default (webm) — same outcome as explicitly listing webm, minus the dead
// entries here.
const MIME_TYPES = ["video/mp4;codecs=avc1,mp4a", "video/mp4"];

function pickMimeType(): string | undefined {
  return pickSupportedType(MIME_TYPES, (type) => MediaRecorder.isTypeSupported(type));
}

/** One audio-only stem recorder running beside the main one. */
type StemRecorder = { recorder: MediaRecorder; chunks: Blob[]; startedAt: number | null };
type StemRecorders = { mic: StemRecorder; reader: StemRecorder; mimeType: string };

export type RecordedTake = { blob: Blob; stems: TapeStems | null };

// A stem that never reports stopping must not hold up saving the take.
const STEM_STOP_TIMEOUT_MS = 2000;

function createStemRecorder(stream: MediaStream, mimeType: string | undefined): StemRecorder {
  const stem: StemRecorder = {
    recorder: new MediaRecorder(stream, mimeType ? { mimeType } : undefined),
    chunks: [],
    startedAt: null,
  };
  stem.recorder.ondataavailable = (event) => {
    if (event.data.size > 0) stem.chunks.push(event.data);
  };
  stem.recorder.onstart = () => {
    stem.startedAt = performance.now();
  };
  return stem;
}

/** Stops a stem and resolves with its audio, or null if it never started,
 * captured nothing, or didn't stop in time. Never rejects. */
function stopStem(stem: StemRecorder): Promise<Blob | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), STEM_STOP_TIMEOUT_MS);
    const finish = () => {
      clearTimeout(timer);
      const blob = new Blob(stem.chunks, { type: stem.recorder.mimeType });
      resolve(stem.startedAt !== null && blob.size > 0 ? blob : null);
    };
    try {
      if (stem.recorder.state === "inactive") {
        finish();
        return;
      }
      stem.recorder.onstop = finish;
      stem.recorder.stop();
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

/** Runs `action` on each stem recorder, swallowing failures: a stem going
 * wrong costs the take its adjustable reader volume, never the take. */
function eachStem(stems: StemRecorders | null, action: (recorder: MediaRecorder) => void) {
  if (!stems) return;
  for (const stem of [stems.mic, stems.reader]) {
    try {
      action(stem.recorder);
    } catch (err) {
      logAudioEvent("recorder", `stem recorder call failed: ${err}`);
    }
  }
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
 * Alongside that one mixed recording, the mic and the reader are each also
 * recorded on their own as audio-only stems, so the reader's level in the
 * finished tape can be changed afterwards on the review screen (see
 * useTapeRemix.ts) — best-effort, never at the main recording's expense.
 * `pause()`/`resume()` pause and resume capture without releasing the
 * camera. `stop()` resolves with the finished recording as a Blob (plus its
 * stems, when they recorded cleanly) and releases the camera. Permission failures land in `error` rather than
 * throwing.
 */
export function useSelfTapeRecorder() {
  const [status, setStatus] = useState<RecorderStatus>("idle");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const mixNodesRef = useRef<AudioNode[]>([]);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const stemsRef = useRef<StemRecorders | null>(null);
  const mainStartedAtRef = useRef<number | null>(null);

  const disconnectMix = () => {
    mixNodesRef.current.forEach((node) => node.disconnect());
    mixNodesRef.current = [];
  };

  useEffect(() => {
    const cleanup = () => {
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop();
      }
      eachStem(stemsRef.current, (recorder) => {
        if (recorder.state !== "inactive") recorder.stop();
      });
      streamRef.current?.getTracks().forEach((track) => track.stop());
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
      disconnectMix();
    };
    return cleanup;
  }, []);

  const requestCamera = async () => {
    setError(null);
    setStatus("requesting");
    let media: MediaStream;
    try {
      // `video: true` lets iPad Safari hand back its native front-camera
      // format, which on ultra-wide front cameras records a distorted,
      // wide-FOV tape instead of a standard 16:9 self-tape frame. All
      // `ideal`, never `exact`: a device that can't match falls back to its
      // closest format rather than failing getUserMedia outright.
      media = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          aspectRatio: { ideal: 16 / 9 },
        },
        audio: true,
      });
    } catch (err) {
      console.error("Self-tape camera unavailable:", err);
      setStatus("error");
      setError(
        "We couldn't access your camera. Check your browser permissions and try again.",
      );
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
    streamRef.current = media;
    setStream(media);
    setStatus("ready");
  };

  const startRecording = (ttsStream?: MediaStream | null, sharedContext?: AudioContext | null) => {
    const media = streamRef.current;
    if (!media || recorderRef.current) return;

    // Mix the mic with the TTS tap so the recording gets the scene partner's
    // lines directly, not whatever the mic happens to pick up off the
    // speakers. Falls back to mic-only if no tap stream (or shared context)
    // was available.
    let recordingStream = media;
    let stemStreams: { mic: MediaStream; reader: MediaStream } | null = null;
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
      // The stems branch off the very same source nodes as the mix, so all
      // three recordings share one path's latency and line up on replay.
      try {
        const micStem = sharedContext.createMediaStreamDestination();
        const readerStem = sharedContext.createMediaStreamDestination();
        micStem.channelCount = 1;
        readerStem.channelCount = 1;
        micSource.connect(micStem);
        ttsSource.connect(readerStem);
        mixNodesRef.current.push(micStem, readerStem);
        stemStreams = { mic: micStem.stream, reader: readerStem.stream };
      } catch (err) {
        logAudioEvent("recorder", `stem taps unavailable: ${err}`);
      }
      recordingStream = new MediaStream([
        media.getVideoTracks()[0],
        destination.stream.getAudioTracks()[0],
      ]);
    }
    recordingStreamRef.current = recordingStream;

    chunksRef.current = [];
    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(recordingStream, mimeType ? { mimeType } : undefined);
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    mainStartedAtRef.current = null;
    recorder.onstart = () => {
      mainStartedAtRef.current = performance.now();
    };
    recorderRef.current = recorder;
    recorder.start();
    logAudioEvent("recorder", `MediaRecorder.start() called, mimeType=${mimeType ?? "(default)"}`);

    // Started right after the main recorder, never before it: if the
    // platform balks at more than one MediaRecorder, it's a stem that fails.
    stemsRef.current = null;
    if (stemStreams) {
      let stems: StemRecorders | null = null;
      try {
        const stemMimeType = pickSupportedType(stemMimeCandidates(mimeType ?? ""), (type) =>
          MediaRecorder.isTypeSupported(type),
        );
        stems = {
          mic: createStemRecorder(stemStreams.mic, stemMimeType),
          reader: createStemRecorder(stemStreams.reader, stemMimeType),
          mimeType: stemMimeType ?? "",
        };
        stems.mic.recorder.start();
        stems.reader.recorder.start();
        stemsRef.current = stems;
        logAudioEvent("recorder", `stem recorders started, mimeType=${stemMimeType ?? "(default)"}`);
      } catch (err) {
        logAudioEvent("recorder", `stem recorders failed, recording without stems: ${err}`);
        eachStem(stems, (stemRecorder) => {
          if (stemRecorder.state !== "inactive") stemRecorder.stop();
        });
      }
    }
    setStatus("recording");
  };

  // Idempotent — safe to call regardless of current state, so callers don't
  // need to track whether a change is actually a transition.
  const pause = () => {
    if (recorderRef.current?.state === "recording") {
      recorderRef.current.pause();
      eachStem(stemsRef.current, (recorder) => {
        if (recorder.state === "recording") recorder.pause();
      });
      setStatus("paused");
    }
  };

  const resume = () => {
    if (recorderRef.current?.state === "paused") {
      recorderRef.current.resume();
      eachStem(stemsRef.current, (recorder) => {
        if (recorder.state === "paused") recorder.resume();
      });
      setStatus("recording");
    }
  };

  const stop = async (): Promise<RecordedTake | null> => {
    const recorder = recorderRef.current;
    const stemRecorders = stemsRef.current;
    stemsRef.current = null;
    let blob: Blob | null = null;
    // Stems stop alongside the main recorder, not after it, so all three end
    // at the same moment.
    const stemBlobs = stemRecorders
      ? Promise.all([stopStem(stemRecorders.mic), stopStem(stemRecorders.reader)])
      : Promise.resolve([null, null]);
    if (recorder && recorder.state !== "inactive") {
      blob = await new Promise<Blob>((resolve) => {
        recorder.onstop = () =>
          resolve(new Blob(chunksRef.current, { type: recorder.mimeType }));
        recorder.stop();
      });
    }
    let stems: TapeStems | null = null;
    const [mic, reader] = await stemBlobs;
    const mainStartedAt = mainStartedAtRef.current;
    if (stemRecorders && mic && reader && mainStartedAt !== null) {
      stems = {
        mic,
        reader,
        micOffsetMs: (stemRecorders.mic.startedAt ?? mainStartedAt) - mainStartedAt,
        readerOffsetMs: (stemRecorders.reader.startedAt ?? mainStartedAt) - mainStartedAt,
        mimeType: mic.type || stemRecorders.mimeType,
      };
    }

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
    recordingStreamRef.current = null;
    disconnectMix();
    recorderRef.current = null;
    chunksRef.current = [];
    setStream(null);
    setStatus("idle");
    return blob ? { blob, stems } : null;
  };

  return { status, stream, error, requestCamera, startRecording, pause, resume, stop };
}
