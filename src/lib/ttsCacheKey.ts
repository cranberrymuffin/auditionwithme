// The TTS request shape and the cache key both the player (useTtsPlayer.ts)
// and reader-audio pre-generation (useReaderAudioPregen.ts) derive from it.
// One formula is what makes a pre-generated line a cache hit at playback.
// No imports, so the tsx checks in benchmarks/ can exercise it directly.

/** One line of dialogue plus the context the TTS model uses for prosody. */
export type TtsLine = {
  text: string;
  voiceId?: string;
  /** The line spoken before this one — conditions the read as a reply. */
  previousText?: string;
  /** The line spoken after this one. */
  nextText?: string;
  /** Eleven v3 audio tag, e.g. "angry" or "whispers". */
  deliveryTag?: string;
  /** AI-director markup of `text`: inline v3 audio tags + pacing punctuation. */
  performance?: string;
  /** Adds a beat of silence before the line starts — scene-partner lines
   * only, so the read doesn't cut in over an actor's trailing words. */
  leadingPause?: boolean;
};

export type TtsIntensity = "subtle" | "natural" | "dramatic";

/** Identifies one rendered read: same key, same audio. Anything that changes
 * what ElevenLabs would generate (voice, words, direction) changes the key;
 * reader volume and playback speed are applied client-side and don't. */
export const cacheKey = (line: TtsLine, intensity: TtsIntensity) =>
  JSON.stringify([
    line.voiceId ?? "",
    line.text,
    line.deliveryTag ?? "",
    line.performance ?? "",
    line.previousText ?? "",
    line.nextText ?? "",
    line.leadingPause ?? false,
    // Always "natural" now (Rehearsal pins it), but kept in the key: dropping
    // it would change every key's shape and orphan already-cached audio.
    intensity,
  ]);
