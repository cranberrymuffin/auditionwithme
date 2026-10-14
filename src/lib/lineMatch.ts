// Pure line-matching logic for live word tracking (useScribeTracking.ts),
// kept free of app imports (no Supabase/apiFetch) so it can be exercised
// directly under tsx — see benchmarks/checks/cutoff-guard.ts.

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

// How many script tokens in a row the matcher may step over when a later one
// has already been heard. Counted after expansion, so a contraction like
// "I'm" ("i am") uses up both. The lookahead above only gives up on a
// word once 6+ spoken words have gone past it, which a short line never
// reaches: "Get out of here" with its first word lost (the Scribe socket was
// still opening when the actor came in) or misheard would otherwise sit at
// 0 matched forever, out of reach of every fallback.
const MAX_SCRIPT_SKIP = 2;

/** Where the transcript has got to in the line. */
export type LineProgress = {
  /** Script words said, in order — counted in the caller's own words, so it
   * can be compared with `scriptWords.length`. */
  matched: number;
  /** Whether the line's ending has been heard: either the whole line
   * matched, or its last word shows up in what the actor said after
   * everything matched so far. "After" is what keeps an earlier "you" in
   * the line from passing for the "you" it ends on. */
  endingHeard: boolean;
};

const matchesAny = (words: string[], target: string) => words.some((w) => wordsMatch(w, target));

export function assessLine(scriptWords: string[], transcript: string): LineProgress {
  const spoken = tokensOf(transcript);
  const script = expandWords(scriptWords);
  if (!script.length) return { matched: scriptWords.length, endingHeard: true };

  let si = 0;
  let pi = 0;
  while (si < script.length && pi < spoken.length) {
    const windowEnd = Math.min(pi + SKIP_LOOKAHEAD, spoken.length);
    const window = spoken.slice(pi, windowEnd);
    const found = window.findIndex((w) => wordsMatch(w, script[si].token));
    if (found !== -1) {
      si++;
      pi += found + 1;
      continue;
    }
    if (windowEnd < spoken.length) {
      // We already have more than a full lookahead window of trailing
      // transcript and the target never showed up in it — it was likely
      // misheard or skipped. Credit it and move on without consuming any
      // spoken words, so it can't also swallow the match for the next one.
      si++;
      continue;
    }
    // The actor may already be past this word: if one of the next couple of
    // script words is in what's been heard, credit the ones before it and
    // match from there (see MAX_SCRIPT_SKIP).
    let skip = 0;
    for (let k = 1; k <= MAX_SCRIPT_SKIP && si + k < script.length; k++) {
      if (matchesAny(window, script[si + k].token)) {
        skip = k;
        break;
      }
    }
    if (skip) {
      si += skip;
      continue;
    }
    // Not enough trailing transcript yet to know whether the target will
    // still show up (the actor may still be mid-word) — wait rather than
    // guess; a later call with more transcript will resolve it.
    break;
  }
  if (si >= script.length) return { matched: scriptWords.length, endingHeard: true };

  // Every token of the words before the first unmatched token was matched.
  const matched = script[si].from;
  const tail = spoken.slice(pi);
  const last = script[script.length - 1].token;
  let endingHeard = matchesAny(tail, last);
  // A one- or two-letter last word ("me", "go") only ever matches exactly and
  // turns up all over speech, so it has to come right after the word before it.
  if (endingHeard && last.length < 3 && script.length > 1) {
    const before = script[script.length - 2].token;
    endingHeard = tail.some((w, i) => i > 0 && w === last && wordsMatch(tail[i - 1], before));
  }
  return { matched, endingHeard };
}

/** Script words said so far, in order (see LineProgress.matched). */
export function countMatchedWords(scriptWords: string[], transcript: string): number {
  return assessLine(scriptWords, transcript).matched;
}

// Semantic fallback guard. The fallback asks a model whether a stalled
// transcript "conveys" the line (a paraphrase, say), and a model will happily
// say yes to the first half of a monologue — so a mid-speech breath used to
// advance the scene and cut the actor off. It's only consulted once the actor
// has been quiet for the full patient hold (see quietAdvance), word matching
// has already credited most of the line, AND the transcript itself is long
// enough to plausibly be the whole thing.
const SEMANTIC_MIN_MATCHED_FRACTION = 0.7;
const SEMANTIC_MIN_HEARD_FRACTION = 0.6;
// Past this many words, a "yes" from the semantic check alone isn't enough:
// the last few script words must also have been heard, i.e. the actor has
// actually reached the end rather than paused partway through.
const LONG_LINE_WORDS = 40;
const TRAILING_WORDS = 3;

/**
 * Whether a transcript that left the line short of a full word match is
 * worth sending to the semantic fallback at all.
 */
export function shouldTrySemanticFallback(
  scriptWords: string[],
  matchedCount: number,
  transcript: string,
): boolean {
  if (!scriptWords.length || matchedCount >= scriptWords.length) return false;
  const heardWords = transcript.split(/\s+/).filter(Boolean);
  return (
    heardWords.length >= 2 &&
    matchedCount / scriptWords.length >= SEMANTIC_MIN_MATCHED_FRACTION &&
    heardWords.length / scriptWords.length >= SEMANTIC_MIN_HEARD_FRACTION
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
export function semanticMatchMayAdvance(scriptWords: string[], transcript: string): boolean {
  if (scriptWords.length <= LONG_LINE_WORDS) return true;
  const trailing = expandWords(scriptWords).map((t) => t.token).slice(-TRAILING_WORDS);
  const heard = tokensOf(transcript);
  return trailing.every((word) => heard.some((spoken) => wordsMatch(spoken, word)));
}

// Quiet-based advance, for lines the word matcher hasn't fully credited.
// Scribe's realtime API never says "the actor went quiet", so quiet is
// inferred from two independent signals: Scribe has stopped producing new
// text, and the mic itself is quiet (the first alone would also be true while
// the actor is still speaking but Scribe is lagging behind).
//
// How long a quiet counts as "done" turns on whether the line's ending was
// heard (LineProgress.endingHeard) — the one thing that tells a finished line
// whose middle Scribe garbled apart from an actor holding a pause partway
// through. A pause length alone can't: any wait short enough to feel
// responsive also cuts in on a dramatic pause. So:
//  - ending heard: the actor has reached the end; a short quiet is enough.
//  - ending not heard: maybe a clipped last word, maybe a pause for effect.
//    Wait much longer before guessing, and only when the line is a few
//    words short at most.
export const ENDING_HEARD_QUIET_MS = 600;
export const PATIENT_HOLD_MS = 2500;
// RMS of the 3x-boosted mic signal useScribeTracking taps (about -40 dBFS).
export const SILENCE_RMS = 0.01;
const ENDING_HEARD_MIN_MATCHED_FRACTION = 0.7;
const PATIENT_MIN_MATCHED_FRACTION = 0.8;
// Missing words beyond this aren't a clipped ending, they're the rest of the
// line — on a monologue, 80% heard can still leave a dozen words to go.
const PATIENT_MAX_MISSING_WORDS = 4;

export type QuietInputs = {
  scriptWords: string[];
  progress: LineProgress;
  /** Since the last Scribe message that changed transcript text; null if
   * none has arrived yet. */
  msSinceTextChange: number | null;
  /** Since the mic level was last at or above SILENCE_RMS; null if the mic
   * level isn't being measured. */
  msSinceMicActive: number | null;
  /** How long a quiet must last when the ending wasn't heard. */
  holdMs?: number;
};

/** How long both signals have been quiet; null if either isn't known. */
export function quietFor({ msSinceTextChange, msSinceMicActive }: QuietInputs): number | null {
  if (msSinceTextChange === null || msSinceMicActive === null) return null;
  return Math.min(msSinceTextChange, msSinceMicActive);
}

/** Whether the actor has gone quiet with enough of the line heard that it
 * should be credited as finished, and on which rule: "ending" (ending heard,
 * short quiet) or "patient" (ending not heard, long hold). */
export function quietAdvance(inputs: QuietInputs): "ending" | "patient" | null {
  const { scriptWords, progress, holdMs = PATIENT_HOLD_MS } = inputs;
  if (!scriptWords.length || progress.matched >= scriptWords.length) return null;
  const quiet = quietFor(inputs);
  if (quiet === null) return null;
  const fraction = progress.matched / scriptWords.length;
  if (progress.endingHeard && fraction >= ENDING_HEARD_MIN_MATCHED_FRACTION && quiet >= ENDING_HEARD_QUIET_MS) {
    return "ending";
  }
  if (
    fraction >= PATIENT_MIN_MATCHED_FRACTION &&
    scriptWords.length - progress.matched <= PATIENT_MAX_MISSING_WORDS &&
    quiet >= holdMs
  ) {
    return "patient";
  }
  return null;
}

// Scribe's keyterm limits for one session.
const MAX_KEYTERMS = 50;
const MAX_KEYTERM_CHARS = 20;
// Short capitalized words that open a line or sit in front of a name, but
// aren't the kind of word Scribe mishears: interjections ("Oh, …") and titles.
const COMMON_SHORT_CAPITALIZED = new Set([
  "yes", "no", "oh", "so", "now", "hey", "ah", "aw", "eh", "uh", "um", "hi",
  "yo", "ok", "wow", "yep", "nah", "huh", "mr", "mrs", "ms", "dr", "st",
]);
// Abbreviations whose period doesn't end the sentence ("Mr. Lee").
const TITLE_ABBREVIATION = /^(mr|mrs|ms|dr|st)\.$/i;
const CLOSING_PUNCTUATION = /["'”’)\]]+$/;

/** A short word (2–3 letters) still worth biasing toward: a capitalized one
 * like "Ben", "Ana" or "Liv" that reads as a name — mid-sentence, or at a
 * sentence's start only as a direct address ("Ben, wait."), since otherwise
 * that's where every ordinary word ("The", "But") is capitalized too. */
function isShortName(word: string, raw: string, previousRaw: string | undefined): boolean {
  if (!/^\p{Lu}\p{Ll}+$/u.test(word)) return false; // not "I", "OK", "TV"
  if (COMMON_SHORT_CAPITALIZED.has(word.toLowerCase())) return false;
  const previous = previousRaw?.replace(CLOSING_PUNCTUATION, "");
  const sentenceStart =
    previous === undefined || (/[.!?…:]$/.test(previous) && !TITLE_ABBREVIATION.test(previous));
  return !sentenceStart || raw.replace(CLOSING_PUNCTUATION, "").endsWith(",");
}

/**
 * Words to bias Scribe toward for this line (its `keyterms`): the line's
 * distinctive vocabulary — character names, unusual script words — which a
 * generic model is most likely to mishear. Short words are skipped as
 * ordinary vocabulary, except short names (isShortName). Letters of any
 * script count, so names like "José" or "Zoë" keep their accents.
 */
export function extractKeyterms(line: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  const raws = line.split(/\s+/).filter(Boolean);
  for (let i = 0; i < raws.length && terms.length < MAX_KEYTERMS; i++) {
    const word = raws[i].replace(/[^\p{L}'-]/gu, "");
    if (word.length > MAX_KEYTERM_CHARS || word.length < 2) continue;
    if (word.length < 4 && !isShortName(word, raws[i], raws[i - 1])) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(word);
  }
  return terms;
}
