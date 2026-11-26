// Shared request/response helpers for endpoints that ask the model for a
// single JSON object back (parse-script.ts, parse-pages.ts, casting.ts).

/** Extract the outermost {...} span from a model response that may carry
 * surrounding prose despite being asked for bare JSON. */
export function extractJson(raw: string): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  return raw.slice(start, end + 1);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** "characters" is optional, but when present must be a string array. */
export function isValidCharacters(characters: unknown): boolean {
  return characters === undefined || isStringArray(characters);
}

// Vercel refuses a request body over 4.5 MB before the function ever runs,
// answering with its own non-JSON 413 — nothing in a route can raise that.
// This catches the same case where the platform doesn't (local dev), and
// keeps the limit written down next to the routes that take large bodies.
const MAX_BODY_BYTES = 4.5 * 1024 * 1024;

/** True when the request declares a body larger than Vercel accepts. */
export function isBodyTooLarge(contentLength: string | undefined): boolean {
  const bytes = Number(contentLength);
  return Number.isFinite(bytes) && bytes > MAX_BODY_BYTES;
}

const IMAGE_SIGNATURES = [
  ["/9j/", "image/jpeg"],
  ["iVBORw0KGgo", "image/png"],
  ["UklGR", "image/webp"],
  ["R0lGOD", "image/gif"],
] as const;

export type ImageMediaType = (typeof IMAGE_SIGNATURES)[number][1];

/** The media type of a base64-encoded image, read from its leading bytes;
 * null when it isn't one of the formats the vision API accepts. */
export function imageMediaType(base64: string): ImageMediaType | null {
  return IMAGE_SIGNATURES.find(([prefix]) => base64.startsWith(prefix))?.[1] ?? null;
}
