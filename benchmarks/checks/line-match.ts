// Checks for the word matcher's stall fixes (src/lib/lineMatch.ts):
// contraction/number normalization, stepping over a lost or misheard word,
// whether the line's ending has been heard, and the quiet-based advance
// rules. The cut-off guarantees live in cutoff-guard.ts.
//
//   npm run test:match
//
// Run with tsx (no test runner in this repo; failures exit non-zero).

import assert from "node:assert/strict";
import {
  assessLine,
  countMatchedWords,
  ENDING_HEARD_QUIET_MS,
  PATIENT_HOLD_MS,
  quietAdvance,
  type QuietInputs,
} from "../../src/lib/lineMatch";

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

check("short line with its first word lost: steps over it", () => {
  // The actor came in while the Scribe socket was still opening.
  assert.equal(countMatchedWords(split("Get out of here"), "out of here"), 4);
});

check("short line with a misheard name first: steps over it", () => {
  assert.equal(countMatchedWords(split("Marcus, wait for me"), "markers wait for me"), 4);
});

check("steps over at most two words", () => {
  // Three unheard words in a row isn't a lost word, it's a different line.
  assert.equal(countMatchedWords(split("Get out of here now"), "here now"), 0);
  assert.equal(countMatchedWords(split("Get out of here now"), "of here now"), 5);
});

check("stepping over doesn't run ahead of the actor", () => {
  // Mid-line partial: only what's actually been said (or stepped over to
  // reach it) is credited.
  assert.equal(countMatchedWords(split("Get out of here before they see you"), "out of"), 3);
});

const LINE = split("You never once asked me what I wanted from any of this, not even when it mattered most");

check("ending heard: whole line matched", () => {
  assert.deepEqual(assessLine(LINE, LINE.join(" ")), { matched: LINE.length, endingHeard: true });
});

check("ending not heard: last word clipped", () => {
  const progress = assessLine(LINE, LINE.slice(0, -1).join(" "));
  assert.deepEqual(progress, { matched: LINE.length - 1, endingHeard: false });
});

check("ending heard past a misheard stretch", () => {
  // The matcher stalls on the garbled words, but the actor reached the end.
  const transcript = [...LINE.slice(0, 12), "mumble", "mumble", ...LINE.slice(-2)].join(" ");
  const progress = assessLine(LINE, transcript);
  assert.ok(progress.matched < LINE.length);
  assert.equal(progress.endingHeard, true);
});

check("an earlier use of the last word isn't the ending", () => {
  // "you" is said early on; paused before the line's own closing "you".
  const line = split("You said you would stay, and I believed you");
  assert.equal(assessLine(line, "you said you would stay and I believed").endingHeard, false);
});

check("short last word needs the word before it right before it", () => {
  const line = split("I told them everything and they still let me go");
  assert.equal(assessLine(line, "I told them everything and mumble go").endingHeard, false);
  assert.equal(assessLine(line, "I told them everything and mumble let me go").endingHeard, true);
});

check("misheard last word (not just missing) is matched fuzzily", () => {
  // "most" heard as "mist": a fuzzy near-miss, matched outright.
  const transcript = [...LINE.slice(0, -1), "mist"].join(" ");
  assert.equal(countMatchedWords(LINE, transcript), LINE.length);
});

// Quiet-based advance: Scribe quiet AND mic quiet, then a short wait once the
// ending's been heard, or the long patient hold when it hasn't.
const at = (heard: number, endingHeard: boolean, quiet: number, overrides: Partial<QuietInputs> = {}): QuietInputs => ({
  scriptWords: LINE,
  progress: { matched: heard, endingHeard },
  msSinceTextChange: quiet,
  msSinceMicActive: quiet,
  ...overrides,
});
const seventy = Math.ceil(LINE.length * 0.7);
const short2 = LINE.length - 2;

check("ending heard + 70% matched: advances after a short quiet", () => {
  assert.equal(quietAdvance(at(seventy, true, ENDING_HEARD_QUIET_MS - 1)), null);
  assert.equal(quietAdvance(at(seventy, true, ENDING_HEARD_QUIET_MS)), "ending");
});

check("ending heard but under 70% matched: no short-quiet advance", () => {
  assert.equal(quietAdvance(at(seventy - 1, true, 10_000)), null);
});

check("ending not heard: waits out the patient hold", () => {
  assert.equal(quietAdvance(at(short2, false, 1_200)), null); // the old 1.2s rule fired here
  assert.equal(quietAdvance(at(short2, false, PATIENT_HOLD_MS - 1)), null);
  assert.equal(quietAdvance(at(short2, false, PATIENT_HOLD_MS)), "patient");
});

check("patient hold is the caller's to set", () => {
  assert.equal(quietAdvance(at(short2, false, 4_000, { holdMs: 5_000 })), null);
  assert.equal(quietAdvance(at(short2, false, 5_000, { holdMs: 5_000 })), "patient");
});

check("ending not heard and more than a few words short: never advances on quiet", () => {
  const short5 = LINE.length - 5;
  assert.ok(short5 / LINE.length >= 0.7);
  assert.equal(quietAdvance(at(short5, false, 60_000)), null);
});

check("actor still speaking but Scribe lagging -> no advance", () => {
  // No new text for a while, but the mic says the actor is still talking.
  assert.equal(quietAdvance(at(short2, true, 3000, { msSinceMicActive: 0 })), null);
  assert.equal(quietAdvance(at(short2, false, 3000, { msSinceMicActive: 300 })), null);
});

check("mic quiet but Scribe still producing text -> no advance", () => {
  assert.equal(quietAdvance(at(short2, true, 3000, { msSinceTextChange: 400 })), null);
});

check("no Scribe text yet, or mic level unmeasured -> no advance", () => {
  assert.equal(quietAdvance(at(short2, true, 3000, { msSinceTextChange: null })), null);
  assert.equal(quietAdvance(at(short2, true, 3000, { msSinceMicActive: null })), null);
});

check("already fully matched -> nothing to do", () => {
  assert.equal(quietAdvance(at(LINE.length, true, 3000)), null);
});

console.log(`\n${passed} checks passed`);
