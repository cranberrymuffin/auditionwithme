import assert from "node:assert/strict";
import {
  normalizeStepContent,
  splitSpeech,
  verbalLineFromContent,
} from "../../api/_screenplay.js";

const parenthetical = splitSpeech("I know. (She shuts the door.) Not now.");
assert.equal(parenthetical.verbalLine, "I know. Not now.");
assert.deepEqual(parenthetical.content, [
  { kind: "verbal", text: "I know." },
  { kind: "nonverbal", text: "(She shuts the door.)" },
  { kind: "verbal", text: "Not now." },
]);

const bracketed = splitSpeech("Wait [laughs] no, I'm serious.");
assert.equal(bracketed.verbalLine, "Wait no, I'm serious.");
assert.deepEqual(bracketed.content, [
  { kind: "verbal", text: "Wait" },
  { kind: "nonverbal", text: "[laughs]" },
  { kind: "verbal", text: "no, I'm serious." },
]);

assert.equal(
  verbalLineFromContent([
    { kind: "verbal", text: "What are you doing?" },
    { kind: "nonverbal", text: "(She backs away.)" },
    { kind: "verbal", text: "Stop!" },
  ]),
  "What are you doing? Stop!",
);

const normalized = normalizeStepContent([
  { kind: "verbal", text: "Go now. (She points to the door.)" },
  { kind: "nonverbal", text: "[They leave.]" },
]);
assert.deepEqual(normalized, [
  { kind: "verbal", text: "Go now." },
  { kind: "nonverbal", text: "(She points to the door.)" },
  { kind: "nonverbal", text: "[They leave.]" },
]);
assert.equal(verbalLineFromContent(normalized), "Go now.");

console.log("Screenplay parsing checks passed.");
