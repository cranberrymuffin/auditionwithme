// Regression checks for the monologue cut-off guard (beta feedback: the
// scene partner jumped in while actors paused partway through a long
// speech). Exercises the real matcher and semantic-fallback guard from
// src/lib/lineMatch.ts — the same functions useScribeTracking.ts calls on
// every Scribe commit — with no network or model calls. The semantic model's
// answer is taken as "yes, it matches" throughout, since that's the worst
// case: the guard has to hold even when the model is wrong.
//
//   npm run test:cutoff
//
// Run with tsx (no test runner in this repo; failures exit non-zero).

import assert from "node:assert/strict";
import {
  countMatchedWords,
  semanticMatchMayAdvance,
  shouldTrySemanticFallback,
} from "../src/lib/lineMatch";

const MONOLOGUE =
  "You want to know why I stayed in this town after everyone else left? " +
  "Because somebody had to keep the lights on at the diner, somebody had to " +
  "remember the names of the regulars, and somebody had to sit with my father " +
  "every evening while he forgot a little more of himself. I never wanted " +
  "applause for it. I just wanted one person to notice before the winter came.";
const scriptWords = MONOLOGUE.split(/\s+/).filter(Boolean);
const words = (from: number, to?: number) => scriptWords.slice(from, to).join(" ");

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

/** What useScribeTracking does on a commit, assuming the semantic check says
 * yes: true when the line would be force-advanced to fully matched. */
function wouldAdvance(transcript: string): boolean {
  const count = countMatchedWords(scriptWords, transcript);
  if (count >= scriptWords.length) return true; // plain word match
  return (
    shouldTrySemanticFallback(scriptWords, count, transcript) &&
    semanticMatchMayAdvance(scriptWords, transcript)
  );
}

check("fixture is a 60+ word monologue (long-line rules apply)", () => {
  assert.ok(scriptWords.length >= 60, `only ${scriptWords.length} words`);
});

const half = Math.floor(scriptWords.length / 2);

check("pause at 50%: word matcher stops short of the full line", () => {
  const count = countMatchedWords(scriptWords, words(0, half));
  assert.ok(count < scriptWords.length, `matched ${count}/${scriptWords.length}`);
});

check("pause at 50%: semantic fallback is not even consulted (matched < 70%)", () => {
  const transcript = words(0, half);
  const count = countMatchedWords(scriptWords, transcript);
  assert.equal(shouldTrySemanticFallback(scriptWords, count, transcript), false);
  assert.equal(wouldAdvance(transcript), false);
});

check("pause at 75%: fallback consulted, but long line's ending not heard -> no advance", () => {
  const transcript = words(0, Math.ceil(scriptWords.length * 0.75));
  const count = countMatchedWords(scriptWords, transcript);
  assert.ok(count / scriptWords.length >= 0.7, `matched fraction ${count / scriptWords.length}`);
  assert.equal(shouldTrySemanticFallback(scriptWords, count, transcript), true);
  assert.equal(semanticMatchMayAdvance(scriptWords, transcript), false);
  assert.equal(wouldAdvance(transcript), false);
});

check("garbled middle but ending heard (>= 70% matched) -> advances", () => {
  // Middle stretch misheard as filler, then the last three words land: the
  // matcher stalls waiting for the misheard words, which is exactly the case
  // the semantic fallback exists for.
  const cut = Math.ceil(scriptWords.length * 0.75);
  const transcript = `${words(0, cut)} mumble mumble ${words(-3)}`;
  const count = countMatchedWords(scriptWords, transcript);
  assert.ok(count < scriptWords.length, "word match alone should not finish the line");
  assert.equal(shouldTrySemanticFallback(scriptWords, count, transcript), true);
  assert.equal(semanticMatchMayAdvance(scriptWords, transcript), true);
  assert.equal(wouldAdvance(transcript), true);
});

check("transcript too short for the line (< 60% of its length) -> not consulted", () => {
  // Even with a (hypothetically) high matched count, a commit far shorter
  // than the line can't be the whole thing.
  const transcript = words(0, Math.floor(scriptWords.length * 0.5));
  assert.equal(
    shouldTrySemanticFallback(scriptWords, Math.ceil(scriptWords.length * 0.8), transcript),
    false,
  );
});

check("fully matched line is never sent to the fallback", () => {
  assert.equal(countMatchedWords(scriptWords, MONOLOGUE), scriptWords.length);
  assert.equal(shouldTrySemanticFallback(scriptWords, scriptWords.length, MONOLOGUE), false);
  assert.equal(wouldAdvance(MONOLOGUE), true);
});

check("short lines skip the trailing-word requirement", () => {
  const short = "I told you we should have left an hour ago".split(" ");
  const transcript = "I told you we should have left an our";
  const count = countMatchedWords(short, transcript);
  assert.ok(count < short.length);
  assert.equal(shouldTrySemanticFallback(short, count, transcript), true);
  assert.equal(semanticMatchMayAdvance(short, transcript), true);
});

check("trailing check compares whole normalized words, not substrings", () => {
  const long = [...scriptWords.slice(0, 50), "and", "don't", "ran"];
  // "dont" (no apostrophe, as STT often returns it) still counts as heard...
  assert.equal(semanticMatchMayAdvance(long, `${words(0, 50)} and dont ran`), true);
  // ...but "ran" isn't satisfied just because "grand" contains it.
  assert.equal(semanticMatchMayAdvance(long, `${words(0, 50)} and dont grand`), false);
});

console.log(`\n${passed} checks passed`);
