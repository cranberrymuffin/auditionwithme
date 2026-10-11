// Checks for reader-audio pre-generation: the shared cache key (a
// pre-generated line must be a hit at playback, and a recast must miss only
// on what changed), which steps count as reader lines, how a line's
// intentional beat is split off its request, the scheduling rules
// that keep pre-generation inside the ElevenLabs Starter plan's 3 shared
// concurrent slots, the start-early gate, and api/tts.ts's pregen hold.
// Pure logic, no browser or network.
//
//   npm run test:pregen
//
// Run with tsx (no test runner in this repo; failures exit non-zero).

import assert from "node:assert/strict";
import { cacheKey } from "../../src/lib/ttsCacheKey";
import {
  buildReaderCue,
  buildReaderLine,
  LONG_BEAT_MS,
  readerLineIndices,
  SHORT_BEAT_MS,
} from "../../src/lib/readerLines";
import { deliveryTagFromContent, leadingDirections, splitLeadingBeat } from "../../src/lib/delivery";
import { sanitizePerformance } from "../../api/_direction";
import {
  canStartTake,
  MAX_PREGEN_WORKERS,
  nextLineToGenerate,
  parseConcurrency,
  shouldHoldPregen,
  START_EARLY_LINES,
  targetWorkers,
} from "../../src/lib/pregenSchedule";
import {
  parseEmotion,
  shouldHoldPregen as serverShouldHold,
  v2Stability,
  v3Stability,
} from "../../api/tts";
import { clampCharacterEmotion } from "../../src/lib/characterDelivery";
import { planReaderAudioEviction } from "../../src/lib/readerAudioStore";
import type { Step } from "../../src/types";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

const step = (speaker: string, verbalLine: string, direction?: string): Step => ({
  speaker,
  verbalLine,
  content: [
    ...(direction ? [{ kind: "nonverbal" as const, text: direction }] : []),
    { kind: "verbal" as const, text: verbalLine },
  ],
});

const steps: Step[] = [
  step("ANNA", "Where were you last night?"),
  step("BEN", "Out."),
  step("ANNA (CONT'D)", "Out where?"),
  step("", ""), // action beat, nothing spoken
  step("BEN", "Does it matter?", "(shouting)"),
  step("CARL (V.O.)", "It always matters."),
];
const voices = { BEN: "voice-ben", CARL: "voice-carl", ANNA: "voice-anna" };
const keysFor = (
  role: string,
  characterVoices: Record<string, string>,
  tags: (string | null)[],
) =>
  readerLineIndices(steps, role).map((index) =>
    cacheKey(buildReaderLine(steps, index, characterVoices, tags)!, "natural"),
  );

check("reader lines skip the actor's role (any extension) and unspoken steps", () => {
  assert.deepEqual(readerLineIndices(steps, "ANNA"), [1, 4, 5]);
  assert.deepEqual(readerLineIndices(steps, "BEN"), [0, 2, 5]);
});

check("listening (no role) makes every spoken line a reader line", () => {
  assert.deepEqual(readerLineIndices(steps, ""), [0, 1, 2, 4, 5]);
});

check("same inputs give identical keys (pre-generated audio is a playback hit)", () => {
  assert.deepEqual(keysFor("ANNA", voices, []), keysFor("ANNA", { ...voices }, []));
});

check("recast with unchanged voices reuses every key", () => {
  const before = keysFor("ANNA", voices, []);
  const after = keysFor("ANNA", { CARL: "voice-carl", BEN: "voice-ben", ANNA: "other" }, []);
  // ANNA's voice changed, but she's the actor here, so no reader key moves.
  assert.deepEqual(after, before);
});

check("changing one character's voice changes only that character's keys", () => {
  const before = keysFor("ANNA", voices, []);
  const after = keysFor("ANNA", { ...voices, BEN: "voice-ben-2" }, []);
  // Reader lines are [BEN, BEN, CARL]
  assert.notEqual(after[0], before[0]);
  assert.notEqual(after[1], before[1]);
  assert.equal(after[2], before[2]);
});

check("new director markup changes only the directed line's key", () => {
  const tags: (string | null)[] = [null, "[flatly] Out.", null, null, null, null];
  const before = keysFor("ANNA", voices, []);
  const after = keysFor("ANNA", voices, tags);
  assert.notEqual(after[0], before[0]);
  assert.equal(after[1], before[1]);
  assert.equal(after[2], before[2]);
});

check("a script parenthetical outranks director markup (so markup can't change its key)", () => {
  const tags: (string | null)[] = [null, null, null, null, "[calm] Does it matter?", null];
  const line = buildReaderLine(steps, 4, voices, tags)!;
  assert.equal(line.deliveryTag, "shouts");
  assert.equal(line.performance, undefined);
  assert.equal(keysFor("ANNA", voices, tags)[1], keysFor("ANNA", voices, [])[1]);
});

check("a legacy single-word director tag is sent as a delivery tag", () => {
  const line = buildReaderLine(steps, 1, voices, [null, "annoyed"])!;
  assert.equal(line.deliveryTag, "annoyed");
  assert.equal(line.performance, undefined);
});

check("a coached line is just its take and voice: no direction, emotion, or context", () => {
  const tags: (string | null)[] = [null, "[flatly] Out.", null, null, null, null];
  const line = buildReaderLine(steps, 1, voices, tags, { BEN: 0.5 }, { 1: "take-1" })!;
  assert.deepEqual(line, { text: "Out.", voiceId: "voice-ben", coachTakeId: "take-1" });
});

check("coaching a line changes only that line's key, and a redo changes it again", () => {
  const coachedKeys = (coachTakes: Record<number, string>) =>
    readerLineIndices(steps, "ANNA").map((index) =>
      cacheKey(buildReaderLine(steps, index, voices, [], {}, coachTakes)!, "natural"),
    );
  const before = keysFor("ANNA", voices, []);
  const coached = coachedKeys({ 4: "take-1" });
  assert.equal(coached[0], before[0]);
  assert.notEqual(coached[1], before[1]);
  assert.equal(coached[2], before[2]);
  assert.notEqual(coachedKeys({ 4: "take-2" })[1], coached[1]);
});

check("recasting a coached character re-voices the same take (a new key)", () => {
  const key = (characterVoices: Record<string, string>) =>
    cacheKey(buildReaderLine(steps, 1, characterVoices, [], {}, { 1: "take-1" })!, "natural");
  assert.notEqual(key({ ...voices, BEN: "voice-ben-2" }), key(voices));
});

check("a coached line keeps the script's beat before it", () => {
  const beatSteps: Step[] = [step("ANNA", "Well?"), step("BEN", "No.", "(beat)")];
  const cue = buildReaderCue(beatSteps, 1, voices, [], {}, { 1: "take-1" })!;
  assert.equal(cue.beatMs, SHORT_BEAT_MS);
  assert.equal(cue.line.coachTakeId, "take-1");
});

check("prosody context skips unspoken steps", () => {
  const line = buildReaderLine(steps, 4, voices, [])!;
  assert.equal(line.previousText, "Out where?");
  assert.equal(line.nextText, "It always matters.");
  assert.equal(buildReaderLine(steps, 3, voices, []), null);
});

check("reader lines carry no leading [pause], and the key keeps its old shape", () => {
  const line = buildReaderLine(steps, 1, voices, [])!;
  assert.equal("leadingPause" in line, false);
  const parts = JSON.parse(cacheKey(line, "natural")) as unknown[];
  assert.equal(parts.length, 8);
  assert.equal(parts[6], false); // the old leading-pause slot
  assert.equal(parts[7], "natural");
});

check("a director beat marker is split off: not in the text, performance, or key", () => {
  const marked = sanitizePerformance("[long pause] [sighs] Out.", "Out.");
  // The server keeps the marker and the spoken words are untouched.
  assert.equal(marked, "[long pause] [sighs] Out.");
  const cue = buildReaderCue(steps, 1, voices, [null, marked])!;
  assert.equal(cue.beatMs, LONG_BEAT_MS);
  assert.equal(cue.line.text, "Out.");
  assert.equal(cue.line.performance, "[sighs] Out.");
  assert.equal(cue.line.deliveryTag, undefined);
  assert.ok(!cacheKey(cue.line, "natural").includes("pause"));
});

check("pregen and playback build the same request and key for a beat line", () => {
  const tags = [null, "[short pause] [flatly] Out.", null, null, null, "[long pause] It always matters."];
  for (const index of readerLineIndices(steps, "ANNA")) {
    const pregenLine = buildReaderLine(steps, index, voices, tags)!;
    const playbackLine = buildReaderCue(steps, index, voices, tags)!.line;
    assert.deepEqual(playbackLine, pregenLine);
    assert.equal(cacheKey(playbackLine, "natural"), cacheKey(pregenLine, "natural"));
  }
  assert.equal(buildReaderCue(steps, 1, voices, tags)!.beatMs, SHORT_BEAT_MS);
});

check("a beat-only direction reads (and keys) exactly like the undirected line", () => {
  const marked = sanitizePerformance("[short pause] It always matters.", "It always matters.")!;
  const cue = buildReaderCue(steps, 5, voices, [null, null, null, null, null, marked])!;
  assert.equal(cue.beatMs, SHORT_BEAT_MS);
  assert.equal(cue.line.performance, undefined);
  assert.equal(cacheKey(cue.line, "natural"), cacheKey(buildReaderLine(steps, 5, voices, [])!, "natural"));
});

check("lines without a beat get none, and a mid-line marker stays in the text", () => {
  assert.equal(buildReaderCue(steps, 1, voices, [])!.beatMs, 0);
  const cue = buildReaderCue(steps, 5, voices, [null, null, null, null, null, "It always [short pause] matters."])!;
  assert.equal(cue.beatMs, 0);
  assert.equal(cue.line.performance, "It always [short pause] matters.");
  assert.deepEqual(splitLeadingBeat("[sighs] Out."), { beat: undefined, rest: "[sighs] Out." });
});

check("script beats become a delay, never a [pause] tag, and outrank the director's", () => {
  const beatSteps: Step[] = [
    step("ANNA", "Tell me."),
    step("BEN", "He's gone.", "(beat)"),
    step("BEN", "I'm sorry.", "(a long beat)"),
    step("BEN", "Okay.", "Silence."),
    step("BEN", "Fine.", "(angrily)"),
  ];
  // Director markup without a marker: the script's (beat) still holds.
  const short = buildReaderCue(beatSteps, 1, voices, [null, "[sad] He's gone."])!;
  assert.equal(short.beatMs, SHORT_BEAT_MS);
  assert.equal(short.line.deliveryTag, undefined);
  assert.equal(short.line.performance, "[sad] He's gone.");
  // The script's long beat wins over a director short one.
  const long = buildReaderCue(beatSteps, 2, voices, [null, null, "[short pause] I'm sorry."])!;
  assert.equal(long.beatMs, LONG_BEAT_MS);
  assert.equal(buildReaderCue(beatSteps, 3, voices, [])!.beatMs, LONG_BEAT_MS);
  // A delivery parenthetical still outranks markup, but the director's beat holds.
  const angry = buildReaderCue(beatSteps, 4, voices, [null, null, null, null, "[long pause] [calm] Fine."])!;
  assert.equal(angry.line.deliveryTag, "angry");
  assert.equal(angry.line.performance, undefined);
  assert.equal(angry.beatMs, LONG_BEAT_MS);
  assert.equal(deliveryTagFromContent([{ kind: "nonverbal", text: "(pause)" }]), undefined);
  assert.equal(deliveryTagFromContent([{ kind: "nonverbal", text: "(silence)" }]), undefined);
});

check("a beat after the first words doesn't delay the line", () => {
  const midLine: Step = {
    speaker: "BEN",
    verbalLine: "I know. Go.",
    content: [
      { kind: "verbal", text: "I know." },
      { kind: "nonverbal", text: "(beat)" },
      { kind: "verbal", text: "Go." },
    ],
  };
  assert.equal(buildReaderCue([midLine], 0, voices, [])!.beatMs, 0);
});

check("the director sees only the directions before a line, clipped", () => {
  assert.equal(leadingDirections(steps[4].content), "(shouting)");
  assert.equal(leadingDirections(steps[0].content), "");
  const long = leadingDirections([{ kind: "nonverbal", text: "x".repeat(500) }]);
  assert.equal(long.length, 200);
});

check("concurrency headers parse, and junk/missing ones read as unknown", () => {
  assert.deepEqual(parseConcurrency("1", "3"), { current: 1, max: 3 });
  assert.equal(parseConcurrency(null, "3"), null);
  assert.equal(parseConcurrency("x", "3"), null);
  assert.equal(parseConcurrency("1", "0"), null);
});

check("pregen holds only when one account slot (or none) is left", () => {
  assert.equal(shouldHoldPregen(null), false);
  assert.equal(shouldHoldPregen({ current: 0, max: 3 }), false);
  assert.equal(shouldHoldPregen({ current: 1, max: 3 }), false);
  assert.equal(shouldHoldPregen({ current: 2, max: 3 }), true);
  assert.equal(shouldHoldPregen({ current: 3, max: 3 }), true);
});

check("two workers only before the take, with no 429 seen, and two slots free", () => {
  const idle = { current: 1, max: 3 };
  assert.equal(targetWorkers({ takeActive: false, rateLimited: false, concurrency: idle }), MAX_PREGEN_WORKERS);
  assert.equal(MAX_PREGEN_WORKERS, 2);
  assert.equal(targetWorkers({ takeActive: false, rateLimited: false, concurrency: { current: 2, max: 3 } }), 1);
  assert.equal(targetWorkers({ takeActive: false, rateLimited: false, concurrency: null }), 1);
  assert.equal(targetWorkers({ takeActive: false, rateLimited: true, concurrency: idle }), 1);
});

check("mid-take pregen never runs more than one worker", () => {
  assert.equal(targetWorkers({ takeActive: true, rateLimited: false, concurrency: { current: 0, max: 5 } }), 1);
});

check("next line follows script order from the playhead, behind-lines last", () => {
  const reader = [1, 4, 6, 9, 12];
  assert.equal(nextLineToGenerate(reader, new Set(reader), 0), 1);
  assert.equal(nextLineToGenerate(reader, new Set([4, 6, 9]), 0), 4);
  // Actor jumped ahead to step 7: 9 is the next upcoming reader line.
  assert.equal(nextLineToGenerate(reader, new Set([4, 9, 12]), 7), 9);
  // Nothing left ahead: go back for the line behind (for a replay).
  assert.equal(nextLineToGenerate(reader, new Set([4]), 7), 4);
  assert.equal(nextLineToGenerate(reader, new Set(), 0), null);
});

check(`start opens once the first ${START_EARLY_LINES} reader lines are ready`, () => {
  const reader = [1, 4, 6, 9, 12];
  assert.equal(canStartTake(reader, new Set([1, 4]), false), false);
  assert.equal(canStartTake(reader, new Set([1, 4, 9]), false), false);
  assert.equal(canStartTake(reader, new Set([1, 4, 6]), false), true);
});

check("start opens with fewer reader lines once all are ready, or when done", () => {
  assert.equal(canStartTake([2, 5], new Set([2]), false), false);
  assert.equal(canStartTake([2, 5], new Set([2, 5]), false), true);
  assert.equal(canStartTake([], new Set(), false), true);
  // done with failures: the missing lines fetch live
  assert.equal(canStartTake([1, 4, 6], new Set([4]), true), true);
});

check("server holds pregen near the limit, but ignores stale readings", () => {
  const now = 1_000_000;
  assert.equal(serverShouldHold({ current: 2, max: 3, updatedAt: now - 1000 }, now), true);
  assert.equal(serverShouldHold({ current: 1, max: 3, updatedAt: now - 1000 }, now), false);
  assert.equal(serverShouldHold({ current: 3, max: 3, updatedAt: now - 60_000 }, now), false);
  // Never seen a reading (cold instance): don't hold.
  assert.equal(serverShouldHold({ current: 0, max: 3, updatedAt: 0 }, now), false);
});

const rec = (cacheKey: string, scriptId: string, size: number, createdAt: string) => ({
  cacheKey,
  scriptId,
  size,
  createdAt,
});
const caps = { perScript: 100, total: 250 };

check("nothing is evicted under both caps", () => {
  const records = [rec("a1", "A", 50, "2026-01-01"), rec("b1", "B", 90, "2026-01-02")];
  assert.deepEqual(planReaderAudioEviction(records, "A", caps), []);
});

check("a script over its own cap loses its oldest lines first", () => {
  const records = [
    rec("a3", "A", 40, "2026-01-03"),
    rec("a1", "A", 40, "2026-01-01"),
    rec("a2", "A", 40, "2026-01-02"),
  ];
  assert.deepEqual(planReaderAudioEviction(records, "A", caps), ["a1"]);
});

check("over the total, least recently generated scripts go whole, never the kept one", () => {
  const records = [
    rec("a1", "A", 90, "2026-01-01"), // oldest, but being rehearsed
    rec("b1", "B", 90, "2026-01-02"),
    rec("b2", "B", 5, "2026-01-05"), // B's newest line is newer than C's
    rec("c1", "C", 90, "2026-01-03"),
  ];
  // total 275 > 250: C (newest 01-03) goes before B (newest 01-05); A is kept.
  assert.deepEqual(planReaderAudioEviction(records, "A", caps), ["c1"]);
});

check("eviction stops once under the total", () => {
  const records = [
    rec("b1", "B", 100, "2026-01-01"),
    rec("c1", "C", 100, "2026-01-02"),
    rec("d1", "D", 100, "2026-01-03"),
  ];
  assert.deepEqual(planReaderAudioEviction(records, null, caps), ["b1"]);
});

check("a natural emotion setting keeps the line's existing key", () => {
  const line = buildReaderLine(steps, 1, voices, [], { BEN: 0 })!;
  assert.equal("emotion" in line, false);
  assert.equal(cacheKey(line, "natural"), cacheKey(buildReaderLine(steps, 1, voices, [])!, "natural"));
});

check("an emotion setting changes only that speaker's keys", () => {
  const plain = keysFor("ANNA", voices, []);
  const emotional = readerLineIndices(steps, "ANNA").map((index) =>
    cacheKey(buildReaderLine(steps, index, voices, [], { BEN: 0.5 })!, "natural"),
  );
  assert.notEqual(emotional[0], plain[0]); // BEN
  assert.notEqual(emotional[1], plain[1]); // BEN
  assert.equal(emotional[2], plain[2]); // CARL
  assert.equal(buildReaderCue(steps, 1, voices, [], { BEN: 0.5 })!.line.emotion, 0.5);
});

check("emotion settings snap to the slider's stops", () => {
  assert.equal(clampCharacterEmotion(undefined), 0);
  assert.equal(clampCharacterEmotion(-0.1), 0);
  assert.equal(Object.is(clampCharacterEmotion(-0.1), -0), false);
  assert.equal(clampCharacterEmotion(0.4), 0.5);
  assert.equal(clampCharacterEmotion(7), 1);
});

check("emotion moves stability, but never a script's big delivery", () => {
  assert.equal(v3Stability(false), 0.3);
  assert.equal(v3Stability(false, 1), 0);
  assert.equal(v3Stability(false, 0.5), 0.15);
  assert.equal(v3Stability(false, -1), 0.6);
  assert.equal(v3Stability(true, -1), 0);
  assert.equal(v2Stability(), 0.45);
  assert.equal(v2Stability(1), 0.15);
  assert.equal(v2Stability(-1), 0.75);
  assert.equal(parseEmotion("1"), 0);
  assert.equal(parseEmotion(-9), -1);
});

console.log(`\n${passed} checks passed`);
