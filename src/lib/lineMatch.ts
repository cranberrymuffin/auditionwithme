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

// Contractions and digits STT and scripts write differently ("I'm" vs "I
// am", "2" vs "two"). Both the script and the transcript go through this, so
// either spelling on either side lines up. Keys are normalized (lowercase,
// apostrophes stripped), which makes a few of them collide with real words
// ("were", "its", "lets") — harmless, since both sides expand the same way.
const EXPANSIONS: Record<string, string[]> = {
  im: ["i", "am"], ive: ["i", "have"], youre: ["you", "are"], youve: ["you", "have"],
  youll: ["you", "will"], hes: ["he", "is"], shes: ["she", "is"], its: ["it", "is"],
  itll: ["it", "will"], were: ["we", "are"], weve: ["we", "have"],
  theyre: ["they", "are"], theyve: ["they", "have"], theyll: ["they", "will"],
  thats: ["that", "is"], whats: ["what", "is"], lets: ["let", "us"],
  dont: ["do", "not"], doesnt: ["does", "not"], didnt: ["did", "not"],
  cant: ["can", "not"], cannot: ["can", "not"], wont: ["will", "not"],
  isnt: ["is", "not"], arent: ["are", "not"], wasnt: ["was", "not"],
  werent: ["were", "not"], havent: ["have", "not"], hasnt: ["has", "not"],
  couldnt: ["could", "not"], wouldnt: ["would", "not"], shouldnt: ["should", "not"],
  gonna: ["going", "to"], wanna: ["want", "to"],
  "1": ["one"], "2": ["two"], "3": ["three"], "4": ["four"], "5": ["five"],
  "6": ["six"], "7": ["seven"], "8": ["eight"], "9": ["nine"], "10": ["ten"],
};

const normWord = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Normalized, contraction/number-expanded tokens of `words`, each tagged
 * with the index of the word it came from. Punctuation-only words ("—")
 * produce no tokens. */
function expandWords(words: string[]): { token: string; from: number }[] {
  const out: { token: string; from: number }[] = [];
  words.forEach((word, from) => {
    const norm = normWord(word);
    if (!norm) return;
    for (const token of EXPANSIONS[norm] ?? [norm]) out.push({ token, from });
  });
  return out;
}

const tokensOf = (text: string) => expandWords(text.split(/\s+/)).map((t) => t.token);

// VAD often clips the very end of a line (the last word trails off below its
// threshold, or Scribe drops it from the commit), leaving an otherwise
// complete line one or two words short forever. Once the actor has paused
// with nearly the whole line heard, credit those last words.
const LAST_WORDS_TOLERANCE = 2;
const LAST_WORDS_MIN_MATCHED_FRACTION = 0.85;

/**
 * How many of `scriptWords` (counted in the caller's own words, so it can be
 * compared with `scriptWords.length`) the transcript has said, in order.
 *
 * `atPause`: the transcript is a VAD commit with nothing after it — the actor
 * has stopped. Only then may the last 1-2 words be credited unheard (see
 * LAST_WORDS_TOLERANCE); mid-speech, a transcript one word short of the end
 * just means the actor hasn't said that word yet.
 */
export function countMatchedWords(
  scriptWords: string[],
  transcript: string,
  { atPause = false }: { atPause?: boolean } = {},
): number {
  const spoken = tokensOf(transcript);
  const script = expandWords(scriptWords);

  let si = 0;
  let pi = 0;
  while (si < script.length && pi < spoken.length) {
    const windowEnd = Math.min(pi + SKIP_LOOKAHEAD, spoken.length);
    const found = spoken.slice(pi, windowEnd).findIndex((w) => wordsMatch(w, script[si].token));
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
  // Every token of the words before the first unmatched token was matched.
  const matched = si >= script.length ? scriptWords.length : script[si].from;
  const missing = scriptWords.length - matched;
  if (
    atPause &&
    missing > 0 &&
    missing <= LAST_WORDS_TOLERANCE &&
    matched / scriptWords.length >= LAST_WORDS_MIN_MATCHED_FRACTION
  ) {
    return scriptWords.length;
  }
  return matched;
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
 * compared as normalized, contraction-expanded words, not substrings, so
 * "don't" matches "dont" or "do not" and "a" doesn't match inside any word
 * containing an "a").
 */
export function semanticMatchMayAdvance(scriptWords: string[], committed: string): boolean {
  if (scriptWords.length <= LONG_LINE_WORDS) return true;
  const trailing = expandWords(scriptWords).map((t) => t.token).slice(-TRAILING_WORDS);
  const heard = tokensOf(committed);
  return trailing.every((word) => heard.some((spoken) => wordsMatch(spoken, word)));
}
