import { apiFetch } from "./api";

export type Voice = {
  id: string;
  name: string;
  gender: string;
  age: string;
  accent: string;
  description: string;
  language: string;
  locale: string;
  tone: string;
};

export function describeVoice(v: Voice): string {
  return [v.accent, v.gender, v.age, v.tone].filter(Boolean).map(humanizeVoiceLabel).join(" · ");
}

export function voiceDisplayName(name: string): string {
  return name.split(/\s+-\s+/)[0].trim();
}

export function humanizeVoiceLabel(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function normalizeSpeaker(name: string): string {
  return name
    .replace(/\s*\(cont['']?d\.?\)/gi, "")
    .replace(/\s*\(v\.?o\.?\)/gi, "")
    .replace(/\s*\(o\.?s\.?\)/gi, "")
    .replace(/\s*\(o\.?c\.?\)/gi, "")
    .replace(/\s*\(pre-lap\)/gi, "")
    .trim();
}

// How many spoken words we scan ahead looking for the current target word
// before giving up on it and moving to the next one. Without this, a single
// misheard or skipped script word (very common with realtime STT on
// character names and unusual script vocabulary) would permanently stall
// matching for the rest of the line, even though every later word was
// spoken and recognized correctly.
const SKIP_LOOKAHEAD = 6;

function levenshtein(a: string, b: string): number {
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      curr[j] =
        a[i - 1] === b[j - 1]
          ? prev[j - 1]
          : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

// STT mishears are usually a near-miss (transcribed as a similarly-spelled
// word, e.g. "there"/"their", a dropped letter, a wrong ending) rather than
// a completely different word. Exact-only matching treats those the same
// as a genuine miss, which is what forces manual advance on lines that were
// actually spoken correctly. Words under 3 characters are excluded since
// edit-distance tolerance on them is dominated by noise (nearly any short
// word is "close" to any other).
function wordsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 3 || b.length < 3) return false;
  const maxLen = Math.max(a.length, b.length);
  return levenshtein(a, b) / maxLen <= 0.25;
}

export function countMatchedWords(scriptWords: string[], transcript: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const spoken = transcript.toLowerCase().split(/\s+/).map(norm).filter(Boolean);
  const script = scriptWords.map(norm).filter(Boolean);

  let si = 0;
  let pi = 0;
  while (si < script.length && pi < spoken.length) {
    const windowEnd = Math.min(pi + SKIP_LOOKAHEAD, spoken.length);
    const found = spoken.slice(pi, windowEnd).findIndex((w) => wordsMatch(w, script[si]));
    if (found !== -1) {
      si++;
      pi += found + 1;
    } else if (windowEnd < spoken.length) {
      // We already have more than a full lookahead window of trailing
      // transcript and the target never showed up in it — it was likely
      // misheard or skipped. Credit it and move on without consuming any
      // spoken words, so it can't also swallow the match for the next one.
      si++;
    } else {
      // Not enough trailing transcript yet to know whether the target will
      // still show up (the actor may still be mid-word) — wait rather than
      // guess; a later call with more transcript will resolve it.
      break;
    }
  }
  return si;
}

/**
 * Fallback for a line that stalled short of a full countMatchedWords match
 * even after the actor paused (nothing left to transcribe for this attempt):
 * asks the server whether the transcript it did get still conveys the
 * line's meaning, tolerating mishears/garbling that exact/fuzzy word
 * matching couldn't get past. Returns false (never advance) on any request
 * failure rather than surfacing an error into the rehearsal flow.
 */
export async function checkSemanticLineMatch(line: string, transcript: string): Promise<boolean> {
  try {
    const response = await apiFetch("/api/casting?action=semantic-match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ line, transcript }),
    });
    if (!response.ok) return false;
    const data = (await response.json()) as { match?: boolean };
    return data.match === true;
  } catch {
    return false;
  }
}
