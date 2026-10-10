// Each scene partner's emotion and pace, set beside Volume on the voice setup
// screen and fixed for the take. No imports, so the tsx checks in
// benchmarks/ can exercise it directly.
//
// Emotion is generated: it rides on the TTS request (api/tts.ts turns it into
// ElevenLabs stability) and is part of the cache key, so changing it
// regenerates that character's lines. Pace is like volume: a playback rate
// (pitch-preserving) applied client-side, never baked into generated audio, so
// changing it costs nothing.

/** -1 (very reserved) … 0 (natural, the old fixed read) … 1 (very expressive). */
export const DEFAULT_CHARACTER_EMOTION = 0;
export const CHARACTER_EMOTION_STEP = 0.5;

const EMOTION_LABELS: Record<string, string> = {
  "-1": "Very reserved",
  "-0.5": "Reserved",
  "0": "Natural",
  "0.5": "Expressive",
  "1": "Very expressive",
};

/** A stored or entered emotion, made safe to use (missing → natural),
 * snapped to the slider's stops so equal reads share a cache key. */
export function clampCharacterEmotion(emotion: unknown): number {
  if (typeof emotion !== "number" || !Number.isFinite(emotion)) return DEFAULT_CHARACTER_EMOTION;
  const clamped = Math.min(Math.max(emotion, -1), 1);
  // `|| 0` turns -0 into 0, so it labels and keys as natural.
  return Math.round(clamped / CHARACTER_EMOTION_STEP) * CHARACTER_EMOTION_STEP || 0;
}

export const characterEmotionLabel = (emotion: number) =>
  EMOTION_LABELS[String(clampCharacterEmotion(emotion))];

/** Playback rate: 1 = as generated. Kept to a range that still sounds like
 * someone talking rather than a fast-forward. */
export const DEFAULT_CHARACTER_PACE = 1;
export const MIN_CHARACTER_PACE = 0.8;
export const MAX_CHARACTER_PACE = 1.25;

/** A stored or entered pace, made safe to use (missing → default). */
export function clampCharacterPace(pace: number | null | undefined): number {
  if (typeof pace !== "number" || !Number.isFinite(pace)) return DEFAULT_CHARACTER_PACE;
  return Math.min(Math.max(pace, MIN_CHARACTER_PACE), MAX_CHARACTER_PACE);
}

export const characterPaceLabel = (pace: number) =>
  pace === DEFAULT_CHARACTER_PACE
    ? "Normal"
    : `${pace < 1 ? "Slower" : "Faster"} ${Math.round(Math.abs(pace - 1) * 100)}%`;
