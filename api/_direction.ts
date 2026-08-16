// Shared validation for AI-director "performance markup": a dialogue line
// annotated with Eleven v3 audio tags ("[sighs]"), pacing punctuation
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
    .replace(/\[([^\]]*)\]/g, (_, inner: string) =>
      /^[a-z][a-z ]{0,23}$/i.test(inner.trim())
        ? `[${inner.trim().toLowerCase()}]`
        : " ",
    )
    .replace(/ {2,}/g, " ")
    .trim();
  if (spokenWords(cleaned) !== spokenWords(originalText)) return null;
  return cleaned;
}
