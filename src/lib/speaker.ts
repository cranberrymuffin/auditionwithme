// No imports, so pure modules (readerLines.ts) and the tsx checks in
// benchmarks/ can use it without pulling in Supabase via lib/script.ts.

/** A screenplay speaker label with its extensions ("(CONT'D)", "(V.O.)", …)
 * stripped, so every line by one character groups under one name. */
export function normalizeSpeaker(name: string): string {
  return name
    .replace(/\s*\(cont['']?d\.?\)/gi, "")
    .replace(/\s*\(v\.?o\.?\)/gi, "")
    .replace(/\s*\(o\.?s\.?\)/gi, "")
    .replace(/\s*\(o\.?c\.?\)/gi, "")
    .replace(/\s*\(pre-lap\)/gi, "")
    .trim();
}
