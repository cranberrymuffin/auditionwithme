// Pure line-matching logic for live word tracking (useScribeTracking.ts),
// kept free of app imports (no Supabase/apiFetch) so it can be exercised
// directly under tsx — see benchmarks/cutoff-guard.ts.

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

// Semantic fallback guard. The fallback asks a model whether a stalled
// transcript "conveys" the line, and a model will happily say yes to the
// first half of a monologue — so a mid-speech breath (which VAD commits like
// any other pause) used to advance the scene and cut the actor off. It's now
// only consulted once word matching has already credited most of the line
// AND the transcript itself is long enough to plausibly be the whole thing.
const SEMANTIC_MIN_MATCHED_FRACTION = 0.7;
const SEMANTIC_MIN_COMMITTED_FRACTION = 0.6;
// Past this many words, a "yes" from the semantic check alone isn't enough:
// the last few script words must also have been heard, i.e. the actor has
// actually reached the end rather than paused partway through.
const LONG_LINE_WORDS = 40;
const TRAILING_WORDS = 3;

const normWord = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Whether a VAD-committed transcript that left the line short of a full word
 * match is worth sending to the semantic fallback at all.
 */
export function shouldTrySemanticFallback(
  scriptWords: string[],
  matchedCount: number,
  committed: string,
): boolean {
  if (!scriptWords.length || matchedCount >= scriptWords.length) return false;
  const committedWords = committed.split(/\s+/).filter(Boolean);
  return (
    committedWords.length >= 2 &&
    matchedCount / scriptWords.length >= SEMANTIC_MIN_MATCHED_FRACTION &&
    committedWords.length / scriptWords.length >= SEMANTIC_MIN_COMMITTED_FRACTION
  );
}

/**
 * Whether a positive semantic match may actually advance the line. Short
 * lines: always. Long lines: only if each of the line's last few words shows
 * up in the transcript (fuzzily, same tolerance as countMatchedWords —
 * compared as normalized words, not substrings, so "don't" matches "dont"
 * and "a" doesn't match inside any word containing an "a").
 */
export function semanticMatchMayAdvance(scriptWords: string[], committed: string): boolean {
  if (scriptWords.length <= LONG_LINE_WORDS) return true;
  const trailing = scriptWords.map(normWord).filter(Boolean).slice(-TRAILING_WORDS);
  const heard = committed.split(/\s+/).map(normWord).filter(Boolean);
  return trailing.every((word) => heard.some((spoken) => wordsMatch(spoken, word)));
}
