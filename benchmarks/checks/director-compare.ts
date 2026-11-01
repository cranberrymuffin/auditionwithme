// Checks the on-device director's pure parts (src/lib/onDeviceDirector.ts)
// and the comparison that gates it (src/lib/directorCompare.ts). The model
// itself only runs on an iPhone — see the Admin page's on-device check.
import assert from "node:assert/strict";
import { applyChunk, chunkPrompt, chunkRanges, type DirectorLine } from "../../src/lib/onDeviceDirector";
import { compareDirectors, directorGate, poolComparisons } from "../../src/lib/directorCompare";

const lines: DirectorLine[] = [
  { speaker: "ANNA", text: "Did you get the results?" },
  { speaker: "BEN", text: "Yeah." },
  { speaker: "ANNA", text: "And?" },
  { speaker: "BEN", text: "It's back. The cancer's back.", direction: "(a long [beat])" },
  { speaker: "", text: "", direction: "The kettle clicks off." },
];

// Chunks cover every row once, in order.
assert.deepEqual(chunkRanges(0), []);
assert.deepEqual(chunkRanges(5), [[0, 5]]);
assert.deepEqual(chunkRanges(40), [[0, 16], [16, 32], [32, 40]]);

// Earlier rows ride along marked as context; script brackets are stripped
// so they can't pose as markup.
const prompt = chunkPrompt(lines, 3, 5);
assert.match(prompt, /^Scene rows:\n0\| context ANNA: Did you get the results\?/);
assert.match(prompt, /3\| \{stage: \(a long beat\)\} BEN: It's back\./);
assert.doesNotMatch(prompt.split("\n").find((row) => row.startsWith("3|"))!, /context/);

// Only valid markup for rows inside the chunk lands; changed words, context
// rows, made-up rows, stage-only rows and no-op markup are dropped.
const tags: (string | null)[] = lines.map(() => null);
const counts = applyChunk(tags, lines, [2, 5], [
  { row: 3, markup: "[long pause] It's back. The cancer's back." },
  { row: 2, markup: "And?" },
  { row: 1, markup: "[sighs] Yeah." },
  { row: 4, markup: "[sighs]" },
  { row: 9, markup: "[calm] Hello." },
]);
assert.deepEqual(counts, { returned: 5, kept: 1 });
assert.deepEqual(tags, [null, null, null, "[long pause] It's back. The cancer's back.", null]);
const rewritten: (string | null)[] = lines.map(() => null);
applyChunk(rewritten, lines, [0, 5], [{ row: 0, markup: "Did you get the test results?" }]);
assert.equal(rewritten[0], null);

// Comparison against the cloud's markup.
const texts = lines.map((line) => line.text);
const cloud = [null, null, "[hesitant] And?", "[long pause] It's back. The cancer's back.", null];
const onDevice = [null, "[sad] Yeah.", "[nervous] And?", "[long pause] [sad] It's back. The cancer's back.", null];
const comparison = compareDirectors(texts, cloud, onDevice, { returned: 3, kept: 3 });
assert.equal(comparison.lines, 4);
assert.equal(comparison.cloudDirectedRate, 0.5);
assert.equal(comparison.onDeviceDirectedRate, 0.75);
assert.equal(comparison.directedAgreement, 0.75);
assert.equal(comparison.beatRecall, 1);
assert.equal(comparison.beatPrecision, 1);
assert.equal(comparison.tagOverlap, 0); // hesitant vs nervous; beats aren't tags

// The gate: passes a director close to the cloud's, fails one that tags
// everything or breaks lines.
const pass = directorGate(poolComparisons([comparison]));
assert.ok(pass.every((check) => check.pass), JSON.stringify(pass));
const overActing = compareDirectors(texts, cloud, texts.map((t) => (t ? `[sad] ${t}` : null)), { returned: 4, kept: 4 });
assert.equal(directorGate(overActing).find((c) => c.name === "Doesn't over-act")!.pass, false);
assert.equal(directorGate(overActing).find((c) => c.name === "Finds the script's beats")!.pass, false);
const breaksLines = { ...comparison, returned: 10, kept: 5 };
assert.equal(directorGate(breaksLines).find((c) => c.name === "Keeps the script's words")!.pass, false);

// Pooling weights by lines.
const pooled = poolComparisons([comparison, { ...comparison, lines: 12, cloudDirectedRate: 0.25 }]);
assert.equal(pooled.lines, 16);
assert.equal(pooled.cloudDirectedRate, (0.5 * 4 + 0.25 * 12) / 16);

console.log("director-compare: all checks passed");
