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

export function countMatchedWords(scriptWords: string[], transcript: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const spoken = transcript.toLowerCase().split(/\s+/).map(norm).filter(Boolean);
  const script = scriptWords.map(norm).filter(Boolean);

  let si = 0;
  let pi = 0;
  while (si < script.length && pi < spoken.length) {
    const windowEnd = Math.min(pi + SKIP_LOOKAHEAD, spoken.length);
    const found = spoken.slice(pi, windowEnd).indexOf(script[si]);
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
