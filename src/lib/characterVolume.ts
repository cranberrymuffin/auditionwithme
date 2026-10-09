// Each scene partner's level, set on the voice setup screen and fixed for
// the take. It's a playback-graph gain, never baked into generated audio, so
// changing it costs no regeneration; the self-tape records exactly what the
// actor heard. 1 = unity; up to 2 lets a quiet voice be lifted above the
// actor's own level.
export const DEFAULT_CHARACTER_VOLUME = 1;
export const MAX_CHARACTER_VOLUME = 2;

/** A stored or entered level, made safe to use (missing → default). */
export function clampCharacterVolume(volume: number | null | undefined): number {
  if (typeof volume !== "number" || !Number.isFinite(volume)) return DEFAULT_CHARACTER_VOLUME;
  return Math.min(Math.max(volume, 0), MAX_CHARACTER_VOLUME);
}
