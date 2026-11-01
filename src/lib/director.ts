// Version of the AI director's prompt + tag vocabulary (DIRECTOR_PROMPT in
// api/casting.ts and TAG_VOCABULARY below). Saved scripts store the version their
// delivery tags were generated under; Practice.tsx re-runs direct-lines for
// any script whose stored version is older, so a prompt change actually
// reaches scripts directed before it. Rows saved before versioning existed
// have no version and count as stale. Bump this with every prompt change
// that can change the markup. Not for one that only changes how the answer
// is packaged — like moving to structured output, which returns the same
// markup in a {"lines": [...]} wrapper: a bump re-directs every saved
// script, and re-renders its audio, for nothing.
//   1 — original "skilled actor" prompt (implicit, never stored)
//   2 — reader-first prompt with grounded tags (beta tone feedback, Oct 2026)
//   3 — sees each line's stage directions; may lead a line with a
//       [short pause]/[long pause] beat marker (beta "no pauses" feedback)
//   4 — hesitations inside a line are ellipses, not a [pause] tag (Eleven v4
//       documents punctuation for pauses, not pause tags)
//   5 — written for Eleven v4: may use a short description of the voice as a
//       tag ("[quiet, measured]"); tags never describe actions or staging
export const DIRECTOR_VERSION = 5;

// Emotional tags Eleven v3 and v4 handle well, offered to the director as the core
// palette (validation no longer requires them — sanitizePerformance keeps any
// simple bracketed tag and guarantees the spoken words are unchanged).
// Weighted toward grounded, conversational colors (per ElevenLabs' v3
// audio-tag guidance) because the reader supports an actor's audition rather
// than performing it. High-intensity tags (terrified, shouts, crying,
// desperate, threatening, screams) are deliberately absent: they only reach
// the TTS from an explicit script parenthetical (src/lib/delivery.ts), where
// api/tts.ts's BIG_DELIVERY_TAGS lets them read big on purpose.
// Multi-word tags use spaces, never hyphens — the tag validator
// (normalizeTag, src/lib/direction.ts) only accepts letters, spaces and commas,
// so "[matter-of-fact]" would be silently dropped.
//
// Bump DIRECTOR_VERSION above whenever this list, DIRECTOR_PROMPT
// (api/casting.ts) or the on-device prompt (src/lib/onDeviceDirector.ts)
// changes, so saved scripts get re-directed.
export const TAG_VOCABULARY = [
  "calm", "quietly", "flatly", "matter of fact", "thoughtful", "hesitates",
  "stammers", "gulps", "resigned tone", "sorrowful", "frustrated",
  "angry", "annoyed", "cold", "sad", "somber", "cheerful", "warm",
  "excited", "playful", "teasing", "flirtatious", "nervous", "hesitant",
  "scared", "surprised", "shocked", "confused", "curious",
  "sarcastic", "deadpan", "mocking", "pleading",
  "tired", "resigned", "whispers", "laughs", "sighs",
];
