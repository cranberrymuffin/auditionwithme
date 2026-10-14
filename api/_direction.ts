// Shared validation for AI-director "performance markup": a dialogue line
// annotated with Eleven v4 audio tags ("[sighs]", "[quiet, measured]"), pacing punctuation
// (ellipses, dashes), and CAPS emphasis. Markup may restyle the delivery but
// must speak exactly the same words as the original line.

/** The words actually spoken: bracket tags and punctuation stripped. */
export function spokenWords(value: string): string {
  return value
    .replace(/\[[^\]]*\]/g, " ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** An audio tag's text, normalized ("Quiet ,measured" → "quiet, measured"),
 * or null if it isn't one: letters, spaces and commas only — a word like
 * "[sighs]" or a short description of the voice like "[quiet, measured]",
 * which Eleven v4 reads as direction. Anything else (numbers, symbols,
 * stray script text) could be spoken aloud. */
export function normalizeTag(inner: string): string | null {
  const tag = inner
    .trim()
    .toLowerCase()
    .replace(/\s*,\s*/g, ", ")
    .replace(/ {2,}/g, " ")
    .replace(/,\s*$/, "");
  return /^[a-z][a-z ,]{0,39}$/.test(tag) ? tag : null;
}

/**
 * Cleans a proposed performance markup. Bracket groups that aren't simple
 * audio tags are dropped; returns null when the result doesn't speak exactly
 * the original words (the safe fallback is reading the line unadorned).
 */
export function sanitizePerformance(
  markup: unknown,
  originalText: string,
): string | null {
  if (typeof markup !== "string") return null;
  const trimmed = markup.trim();
  if (!trimmed || trimmed.length > originalText.length * 3 + 100) return null;
  const cleaned = trimmed
    .replace(/\[([^\]]*)\]/g, (_, inner: string) => {
      const tag = normalizeTag(inner);
      return tag ? `[${tag}]` : " ";
    })
    .replace(/ {2,}/g, " ")
    .trim();
  if (spokenWords(cleaned) !== spokenWords(originalText)) return null;
  return cleaned;
}
