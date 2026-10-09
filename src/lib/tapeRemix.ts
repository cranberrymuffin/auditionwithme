// Pure decisions behind adjusting the scene partner's volume after a take
// (see useTapeRemix.ts and stemMixer.ts for the browser side). A take is
// recorded three ways at once — the usual video with mic + reader mixed in,
// plus a mic-only and a reader-only audio stem (useSelfTapeRecorder.ts) — so
// the reader's level can be changed on the review screen without the actor
// ever having to set it mid-take. Nothing here touches the DOM, Web Audio,
// or the network, so benchmarks/tape-remix.ts can exercise it under tsx.

export const MIN_READER_VOLUME = 0;
export const MAX_READER_VOLUME = 2;
export const DEFAULT_READER_VOLUME = 1;

/** Within this of 1, a level counts as unity: the original file, untouched. */
const UNITY_EPSILON = 0.005;

/** A stored or slider-supplied reader level, made safe: anything that isn't
 * a finite number reads as the default, and the rest is held to 0–2. */
export function clampReaderVolume(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_READER_VOLUME;
  const clamped = Math.min(Math.max(value, MIN_READER_VOLUME), MAX_READER_VOLUME);
  return isUnityVolume(clamped) ? DEFAULT_READER_VOLUME : clamped;
}

export function isUnityVolume(volume: number): boolean {
  return Math.abs(volume - DEFAULT_READER_VOLUME) < UNITY_EPSILON;
}

/** Whether to play the stems (video muted) rather than the video's own mixed
 * audio. Only off-unity: at 100% the video's own track is exactly the mix
 * the stems would rebuild, and it needs no AudioContext — which iOS may
 * refuse to start without a fresh tap. */
export function shouldPlayStems(hasStems: boolean, volume: number): boolean {
  return hasStems && !isUnityVolume(volume);
}

export type DownloadPath = "original" | "remix";

/** At 100% (or for a take with no stems) the saved file already is the
 * answer, so it downloads instantly; anything else has to be re-rendered. */
export function chooseDownloadPath(hasStems: boolean, volume: number): DownloadPath {
  return shouldPlayStems(hasStems, volume) ? "remix" : "original";
}

/** Where to start a stem so it lines up with the video at `videoTime`.
 * `offsetMs` is how long after the main recorder the stem's own recorder
 * started (negative if it started first): stem time 0 sits at video time
 * offsetMs. `offset` is the position within the stem to start from;
 * `delay` (video seconds) is how long to wait first, when the video hasn't
 * reached the stem's start yet. Null once the stem has run out. */
export function alignStem(
  videoTime: number,
  offsetMs: number,
  stemDuration: number,
): { offset: number; delay: number } | null {
  const stemTime = videoTime - offsetMs / 1000;
  if (stemTime < 0) return { offset: 0, delay: -stemTime };
  if (stemTime >= stemDuration) return null;
  return { offset: stemTime, delay: 0 };
}

/** How far the video (the master clock) has moved from where the stems
 * think it is, in seconds — positive when the video is ahead. */
export function measureDrift(
  videoTime: number,
  anchorVideoTime: number,
  anchorClockTime: number,
  clockTime: number,
  rate: number,
): number {
  return videoTime - (anchorVideoTime + (clockTime - anchorClockTime) * rate);
}

export const DRIFT_THRESHOLD_SEC = 0.04;
/** After a re-seek, give the stems this long to settle before judging drift
 * again, so a coarse currentTime can't trigger a restart loop. */
export const RESYNC_COOLDOWN_SEC = 1;

/** Re-seek the stems once drift passes ~40ms (about where speech starts to
 * look out of sync), but never twice within the cooldown. */
export function shouldResync(driftSec: number, secondsSinceLastResync: number): boolean {
  return (
    Math.abs(driftSec) > DRIFT_THRESHOLD_SEC &&
    secondsSinceLastResync >= RESYNC_COOLDOWN_SEC
  );
}

/** First candidate the platform's MediaRecorder supports, if any. */
export function pickSupportedType(
  candidates: readonly string[],
  isSupported: (type: string) => boolean,
): string | undefined {
  return candidates.find((type) => isSupported(type));
}

/** Audio-only stem formats, in the same container family as the main video
 * recording: whatever this browser could record that tape in, it can also
 * decode back (Safari: mp4/AAC; Chrome on webm: Opus). */
export function stemMimeCandidates(mainMimeType: string): string[] {
  const mp4 = ["audio/mp4;codecs=mp4a.40.2", "audio/mp4"];
  const webm = ["audio/webm;codecs=opus", "audio/webm"];
  return mainMimeType.includes("mp4") ? [...mp4, ...webm] : [...webm, ...mp4];
}

/** Formats for a re-rendered tape, keeping the original's family so the
 * download has the same extension and plays in the same places. */
export function remixMimeCandidates(originalMimeType: string): string[] {
  if (originalMimeType.includes("mp4")) {
    return ["video/mp4;codecs=avc1,mp4a", "video/mp4"];
  }
  return ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm"];
}

/** Length to report export progress against. MediaRecorder webm files often
 * carry no duration (the element reports Infinity), so fall back to the end
 * of the longest stem on the video's timeline. */
export function exportDuration(
  videoDuration: number,
  stems: { duration: number; offsetMs: number }[],
): number {
  if (Number.isFinite(videoDuration) && videoDuration > 0) return videoDuration;
  return Math.max(0, ...stems.map((stem) => stem.duration + stem.offsetMs / 1000));
}

/** "1:05" style clock for the export progress line. */
export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** A take's separately recorded audio, saved alongside its video. Offsets
 * are each stem recorder's start relative to the main recorder's, in ms. */
export type TapeStems = {
  mic: Blob;
  reader: Blob;
  micOffsetMs: number;
  readerOffsetMs: number;
  mimeType: string;
};
