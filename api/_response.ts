// Shared response-parsing helpers for endpoints that ask the model for a
// single JSON object back (parse-script.ts, parse-pages.ts).

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
