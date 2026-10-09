// Browser side of adjusting the scene partner's volume after a take: plays a
// take's mic and reader stems in step with its <video>, and re-renders the
// tape with the reader at a new level. The decisions themselves (alignment,
// drift, formats) live in tapeRemix.ts, where they can be tested.
import {
  alignStem,
  clampReaderVolume,
  exportDuration,
  measureDrift,
  pickSupportedType,
  remixMimeCandidates,
  shouldResync,
  type TapeStems,
} from "./tapeRemix";

export type DecodedStems = {
  mic: AudioBuffer;
  reader: AudioBuffer;
  micOffsetMs: number;
  readerOffsetMs: number;
};

/** Decodes both stems up front: buffers can start at any offset instantly,
 * where a media element playing a MediaRecorder webm (no cues, no duration)
 * can't reliably seek at all. */
export async function decodeStems(context: BaseAudioContext, stems: TapeStems): Promise<DecodedStems> {
  const [mic, reader] = await Promise.all([
    stems.mic.arrayBuffer().then((data) => context.decodeAudioData(data)),
    stems.reader.arrayBuffer().then((data) => context.decodeAudioData(data)),
  ]);
  return { mic, reader, micOffsetMs: stems.micOffsetMs, readerOffsetMs: stems.readerOffsetMs };
}

const DRIFT_CHECK_MS = 250;
// Every event after which the stems have to stop until the video says it's
// moving again ('playing', 'seeked', 'ratechange').
const HALT_EVENTS = ["pause", "waiting", "seeking", "ended", "emptied"] as const;

/**
 * Plays decoded stems into `output` following a <video> element: the video's
 * currentTime is the master clock, its play/pause/seek/rate events start and
 * stop the stems, and drift past ~40ms re-seeks them. The reader runs through
 * its own gain node so its level can change live. The video itself should be
 * muted by the caller while this is attached — it carries the same audio,
 * already mixed at 100%.
 */
export class StemMixer {
  private readonly context: AudioContext;
  private readonly stems: DecodedStems;
  private readonly micGain: GainNode;
  private readonly readerGain: GainNode;
  private sources: AudioBufferSourceNode[] = [];
  private video: HTMLVideoElement | null = null;
  private anchor: { video: number; clock: number; rate: number } | null = null;
  private lastResyncAt = -Infinity;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(context: AudioContext, stems: DecodedStems, output: AudioNode) {
    this.context = context;
    this.stems = stems;
    this.micGain = context.createGain();
    this.readerGain = context.createGain();
    this.micGain.connect(output);
    this.readerGain.connect(output);
  }

  setReaderVolume(volume: number) {
    this.readerGain.gain.value = clampReaderVolume(volume);
  }

  attach(video: HTMLVideoElement) {
    this.detachVideo();
    this.video = video;
    video.addEventListener("playing", this.restart);
    video.addEventListener("seeked", this.resumeIfPlaying);
    video.addEventListener("ratechange", this.resumeIfPlaying);
    HALT_EVENTS.forEach((type) => video.addEventListener(type, this.halt));
    this.timer = setInterval(this.checkDrift, DRIFT_CHECK_MS);
    this.resumeIfPlaying();
  }

  /** Stops the stems for good and releases the nodes. */
  dispose() {
    this.detachVideo();
    this.micGain.disconnect();
    this.readerGain.disconnect();
  }

  private detachVideo() {
    const video = this.video;
    if (video) {
      video.removeEventListener("playing", this.restart);
      video.removeEventListener("seeked", this.resumeIfPlaying);
      video.removeEventListener("ratechange", this.resumeIfPlaying);
      HALT_EVENTS.forEach((type) => video.removeEventListener(type, this.halt));
    }
    clearInterval(this.timer);
    this.timer = undefined;
    this.halt();
    this.video = null;
  }

  private readonly halt = () => {
    this.sources.forEach((source) => {
      try {
        source.stop();
      } catch {
        // already stopped
      }
      source.disconnect();
    });
    this.sources = [];
    this.anchor = null;
  };

  private readonly resumeIfPlaying = () => {
    const video = this.video;
    if (video && !video.paused && !video.ended && !video.seeking) this.restart();
    else this.halt();
  };

  /** (Re)starts both stems from wherever the video is right now. */
  private readonly restart = () => {
    this.halt();
    const video = this.video;
    if (!video) return;
    const rate = video.playbackRate || 1;
    const now = this.context.currentTime;
    const videoTime = video.currentTime;
    const plan: [AudioBuffer, number, GainNode][] = [
      [this.stems.mic, this.stems.micOffsetMs, this.micGain],
      [this.stems.reader, this.stems.readerOffsetMs, this.readerGain],
    ];
    for (const [buffer, offsetMs, gain] of plan) {
      const at = alignStem(videoTime, offsetMs, buffer.duration);
      if (!at) continue;
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      // Pitch shifts off 1x; the native controls rarely offer other rates.
      source.playbackRate.value = rate;
      source.connect(gain);
      source.start(now + at.delay / rate, at.offset);
      this.sources.push(source);
    }
    this.anchor = { video: videoTime, clock: now, rate };
    this.lastResyncAt = now;
  };

  private readonly checkDrift = () => {
    const video = this.video;
    const anchor = this.anchor;
    // A suspended context's clock stands still; judging drift against it
    // would just re-seek forever.
    if (!video || !anchor || video.paused || this.context.state !== "running") return;
    const now = this.context.currentTime;
    const drift = measureDrift(video.currentTime, anchor.video, anchor.clock, now, anchor.rate);
    if (shouldResync(drift, now - this.lastResyncAt)) this.restart();
  };
}

type CapturableVideo = HTMLVideoElement & { captureStream?: () => MediaStream };
type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: () => void) => number;
};

function waitForEvent(target: EventTarget, type: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Export cancelled", "AbortError"));
    if (signal.aborted) return onAbort();
    target.addEventListener(type, () => resolve(), { once: true });
    target.addEventListener("error", () => reject(new Error("The tape couldn't be read")), { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The video track to re-record: the element's own captureStream() where the
 * browser has it (Chrome; no re-encode of frames through a canvas), else a
 * canvas the frames are painted onto (Safari, which lacks it). Returns the
 * track plus a function that stops whatever was set up.
 */
function captureVideoTrack(video: HTMLVideoElement): { track: MediaStreamTrack; stop: () => void } {
  const capturable = video as CapturableVideo;
  if (typeof capturable.captureStream === "function") {
    try {
      const track = capturable.captureStream().getVideoTracks()[0];
      if (track) return { track, stop: () => track.stop() };
    } catch {
      // fall through to the canvas
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth || 1280;
  canvas.height = video.videoHeight || 720;
  const paint = canvas.getContext("2d");
  const framed = video as FrameCallbackVideo;
  let running = true;
  const draw = () => {
    if (!running) return;
    paint?.drawImage(video, 0, 0, canvas.width, canvas.height);
    if (typeof framed.requestVideoFrameCallback === "function") framed.requestVideoFrameCallback(draw);
    else requestAnimationFrame(draw);
  };
  draw();
  const track = canvas.captureStream(30).getVideoTracks()[0];
  return {
    track,
    stop: () => {
      running = false;
      track.stop();
    },
  };
}

export type RenderRemixOptions = {
  source: Blob;
  stems: DecodedStems;
  readerVolume: number;
  context: AudioContext;
  /** Element the (muted) video being rendered is shown in. Kept visible:
   * browsers may stop decoding frames of a video nobody can see. */
  host: HTMLElement;
  onProgress: (current: number, total: number) => void;
  signal: AbortSignal;
};

/**
 * Re-records a tape with the reader at `readerVolume`: plays it through once
 * in real time, muted, recording its frames with mic + reader stems mixed
 * via Web Audio. Resolves with the new file (same container family as the
 * original); rejects with an AbortError if `signal` fires.
 */
export async function renderRemix(options: RenderRemixOptions): Promise<Blob> {
  const { source, stems, readerVolume, context, host, onProgress, signal } = options;
  const cleanups: (() => void)[] = [];
  try {
    const video = document.createElement("video");
    const url = URL.createObjectURL(source);
    cleanups.push(() => {
      video.pause();
      video.removeAttribute("src");
      video.load();
      video.remove();
      URL.revokeObjectURL(url);
    });
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = url;
    host.appendChild(video);
    await waitForEvent(video, "loadeddata", signal);

    const destination = context.createMediaStreamDestination();
    const mixer = new StemMixer(context, stems, destination);
    mixer.setReaderVolume(readerVolume);
    cleanups.push(() => mixer.dispose());
    await context.resume();

    const capture = captureVideoTrack(video);
    cleanups.push(capture.stop);
    const mimeType = pickSupportedType(remixMimeCandidates(source.type), (type) =>
      MediaRecorder.isTypeSupported(type),
    );
    const recorder = new MediaRecorder(
      new MediaStream([capture.track, destination.stream.getAudioTracks()[0]]),
      mimeType ? { mimeType } : undefined,
    );
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    cleanups.push(() => {
      if (recorder.state !== "inactive") recorder.stop();
    });

    const total = exportDuration(video.duration, [
      { duration: stems.mic.duration, offsetMs: stems.micOffsetMs },
      { duration: stems.reader.duration, offsetMs: stems.readerOffsetMs },
    ]);
    const report = () => onProgress(Math.min(video.currentTime, total), total);
    video.addEventListener("timeupdate", report);
    report();

    const finished = new Promise<Blob>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("Export cancelled", "AbortError"));
        return;
      }
      recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || source.type }));
      video.addEventListener("ended", () => recorder.stop(), { once: true });
      video.addEventListener("error", () => reject(new Error("The tape couldn't be played")), { once: true });
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("Export cancelled", "AbortError")),
        { once: true },
      );
    });

    // Handled by the await below; this only stops a rejection that lands
    // while play() is still pending from being reported as unhandled.
    finished.catch(() => {});
    mixer.attach(video);
    recorder.start(1000);
    await video.play();
    return await finished;
  } finally {
    cleanups.reverse().forEach((cleanup) => {
      try {
        cleanup();
      } catch {
        // best-effort teardown
      }
    });
  }
}
