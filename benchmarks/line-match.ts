// Checks for the word matcher's stall fixes (src/lib/lineMatch.ts):
// contraction/number normalization, the last-word tolerance for lines VAD
// clipped at the end, and the silence-based advance rule. The cut-off
// guarantees live in cutoff-guard.ts.
//
//   npm run test:match
//
// Run with tsx (no test runner in this repo; failures exit non-zero).

import assert from "node:assert/strict";
import { countMatchedWords, shouldSilenceAdvance, type SilenceInputs } from "../src/lib/lineMatch";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

const split = (line: string) => line.split(/\s+/).filter(Boolean);

check("contraction in the script, expanded in the transcript", () => {
  const line = split("I'm going to the store and you're coming with me");
  assert.equal(countMatchedWords(line, "I am going to the store and you are coming with me"), line.length);
});

check("expanded in the script, contracted in the transcript", () => {
  const line = split("I am not sure what it is");
  assert.equal(countMatchedWords(line, "I'm not sure what it's"), line.length);
  assert.equal(countMatchedWords(split("That is it"), "That's it"), 3);
});

check("apostrophe-less STT spellings still match", () => {
  const line = split("Don't you dare, I can't");
  assert.equal(countMatchedWords(line, "dont you dare i cant"), line.length);
  assert.equal(countMatchedWords(line, "do not you dare I cannot"), line.length);
});

check("digits and number words match both ways", () => {
  assert.equal(countMatchedWords(split("I waited two hours"), "I waited 2 hours"), 4);
  assert.equal(countMatchedWords(split("Give me 5 minutes"), "give me five minutes"), 4);
});

check("half of a contraction isn't credited as the whole word", () => {
  // "I'm" expands to "i am"; hearing only "I" so far leaves it current.
  assert.equal(countMatchedWords(split("I'm leaving"), "I"), 0);
  assert.equal(countMatchedWords(split("I'm leaving"), "I am"), 1);
});

check("count is in the caller's words, punctuation-only words included", () => {
  const line = split("Wait — I know you");
  assert.equal(line.length, 5);
  assert.equal(countMatchedWords(line, "wait I know you"), 5);
  // The dash rides along with the word before it; "I" is next.
  assert.equal(countMatchedWords(line, "wait"), 2);
});

const LINE = split("You never once asked me what I wanted from any of this, not even when it mattered most");

check("last word clipped by VAD: credited at a pause", () => {
  const transcript = LINE.slice(0, -1).join(" ");
  assert.equal(countMatchedWords(LINE, transcript), LINE.length - 1);
  assert.equal(countMatchedWords(LINE, transcript, { atPause: true }), LINE.length);
});

check("last two words clipped: credited at a pause", () => {
  const transcript = LINE.slice(0, -2).join(" ");
  assert.equal(countMatchedWords(LINE, transcript, { atPause: true }), LINE.length);
});

check("last word clipped, mid-speech (no pause yet): not credited", () => {
  // A partial one word short of the end usually means the actor is saying it.
  assert.equal(countMatchedWords(LINE, LINE.slice(0, -1).join(" ")), LINE.length - 1);
});

check("three words short at a pause: not credited", () => {
  assert.equal(countMatchedWords(LINE, LINE.slice(0, -3).join(" "), { atPause: true }), LINE.length - 3);
});

check("short line: tolerance needs >= 85% heard, so a 3-word line isn't credited", () => {
  const short = split("Get out now");
  assert.equal(countMatchedWords(short, "get out", { atPause: true }), 2);
});

check("misheard last word (not just missing) is handled by the matcher, not tolerance", () => {
  // "most" heard as "mist": a fuzzy near-miss, matched outright.
  const transcript = [...LINE.slice(0, -1), "mist"].join(" ");
  assert.equal(countMatchedWords(LINE, transcript), LINE.length);
});

// Silence-based advance: Scribe quiet AND mic quiet AND >= 80% heard.
const at = (heard: number, overrides: Partial<SilenceInputs> = {}): SilenceInputs => ({
  scriptWords: LINE,
  matchedCount: heard,
  transcript: LINE.slice(0, heard).join(" "),
  msSinceTextChange: 1500,
  msSinceMicActive: 1500,
  ...overrides,
});
const eighty = Math.ceil(LINE.length * 0.8);

check("silence: 80% matched + 1.2s of silence -> advance", () => {
  assert.equal(shouldSilenceAdvance(at(eighty, { msSinceTextChange: 1200, msSinceMicActive: 1200 })), true);
});

check("silence: actor still speaking but Scribe lagging -> no advance", () => {
  // No new text for a while, but the mic says the actor is still talking.
  assert.equal(shouldSilenceAdvance(at(eighty, { msSinceTextChange: 3000, msSinceMicActive: 0 })), false);
  assert.equal(shouldSilenceAdvance(at(eighty, { msSinceTextChange: 3000, msSinceMicActive: 600 })), false);
});

check("silence: mic quiet but Scribe still producing text -> no advance", () => {
  assert.equal(shouldSilenceAdvance(at(eighty, { msSinceTextChange: 400 })), false);
});

check("silence: 50% matched + long silence -> no advance", () => {
  const half = Math.floor(LINE.length / 2);
  assert.equal(shouldSilenceAdvance(at(half, { msSinceTextChange: 10_000, msSinceMicActive: 10_000 })), false);
});

check("silence: just under 80% -> no advance", () => {
  assert.equal(shouldSilenceAdvance(at(eighty - 1)), false);
});

check("silence: no Scribe text yet, or mic level unmeasured -> no advance", () => {
  assert.equal(shouldSilenceAdvance(at(eighty, { msSinceTextChange: null })), false);
  assert.equal(shouldSilenceAdvance(at(eighty, { msSinceMicActive: null })), false);
});

check("silence: already fully matched -> nothing to do", () => {
  assert.equal(shouldSilenceAdvance(at(LINE.length)), false);
});

const MONOLOGUE = split(
  "You want to know why I stayed in this town after everyone else left? " +
    "Because somebody had to keep the lights on at the diner, somebody had to " +
    "remember the names of the regulars, and somebody had to sit with my father " +
    "every evening while he forgot a little more of himself. I never wanted " +
    "applause for it. I just wanted one person to notice before the winter came.",
);

check("silence: long line paused at 85% without its ending -> no advance", () => {
  const heard = Math.ceil(MONOLOGUE.length * 0.85);
  const inputs = at(heard, { scriptWords: MONOLOGUE, transcript: MONOLOGUE.slice(0, heard).join(" ") });
  assert.equal(shouldSilenceAdvance(inputs), false);
});

check("silence: long line with a garbled stretch but its ending heard -> advance", () => {
  const heard = Math.ceil(MONOLOGUE.length * 0.85);
  const transcript = `${MONOLOGUE.slice(0, heard).join(" ")} mumble ${MONOLOGUE.slice(-3).join(" ")}`;
  assert.equal(shouldSilenceAdvance(at(heard, { scriptWords: MONOLOGUE, transcript })), true);
});

console.log(`\n${passed} checks passed`);
