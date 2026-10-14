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
  /** The character's emotion setting (lib/characterDelivery.ts), -1 … 1;
   * missing or 0 is the natural read. */
  emotion?: number;
  /** A coached line (coachTakeStore.ts): the actor's own recorded read,
   * re-voiced by speech-to-speech (api/sts.ts) instead of synthesized from
   * text. The take carries the whole performance, so a coached line has no
   * direction, emotion or context. */
  coachTakeId?: string;
};

export type TtsIntensity = "subtle" | "natural" | "dramatic";

/** The model and settings a stored read was rendered with. Neither is in the
 * request the client sends (api/tts.ts chooses them), so this is what makes
 * audio generated under an older default miss the cache instead of playing
 * on. Bump it whenever api/tts.ts changes the model or the stability rules.
 * A bump orphans every stored read anyway, so make it the moment to drop
 * the key's dead slots too: previousText/nextText (api/tts.ts ignores them,
 * so a neighbouring line's edit re-bills an identical read), the old pause
 * flag and intensity.
 *   (absent) — eleven_v3 at 0.3
 *   "eleven_v4@0.3" — the first v4 default (benchmarks/voice/emotion.ts) */
export const RENDER_VERSION = "eleven_v4@0.3";

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
    // Was the leading-pause flag. Lines no longer get a [pause] (the cut-off
    // guard in useScribeTracking.ts protects the actor's trailing words now),
    // but the slot stays so the key keeps the shape existing audio was
    // stored under.
    false,
    // Always "natural" now (Rehearsal pins it), but kept in the key: dropping
    // it would change every key's shape and orphan already-cached audio.
    intensity,
    RENDER_VERSION,
    // Appended only off natural, so lines read at the default keep the key
    // they were already stored under.
    ...(line.emotion ? [line.emotion] : []),
    // Likewise only on coached lines. An object, so it can't be mistaken for
    // the emotion before it.
    ...(line.coachTakeId ? [{ coach: line.coachTakeId }] : []),
  ]);
