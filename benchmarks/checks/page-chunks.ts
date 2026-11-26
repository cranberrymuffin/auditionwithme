// Scanned pages are grouped by count and by size, so no /api/parse-pages
// request passes the platform's body limit.
//
//   npx tsx benchmarks/checks/page-chunks.ts
import assert from "node:assert/strict";
import { MAX_CHUNK_BASE64_CHARS, PAGES_PER_CHUNK, chunkIsFull } from "../../src/lib/pageChunks";

/** Groups page sizes the way parseScannedPdf does. */
function group(sizes: number[]): number[][] {
  const chunks: number[][] = [];
  let current: number[] = [];
  let chars = 0;
  for (const size of sizes) {
    if (chunkIsFull(current.length, chars, size)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(size);
    chars += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

const small = 200_000;
assert.deepEqual(
  group(Array(12).fill(small)).map((chunk) => chunk.length),
  [PAGES_PER_CHUNK, PAGES_PER_CHUNK, 2],
  "small pages group by count alone",
);

const large = 1_500_000;
const largeChunks = group(Array(6).fill(large));
assert.deepEqual(largeChunks.map((chunk) => chunk.length), [2, 2, 2], "large pages group by size");
for (const chunk of largeChunks) {
  assert.ok(chunk.reduce((sum, size) => sum + size, 0) <= MAX_CHUNK_BASE64_CHARS);
}

assert.deepEqual(
  group([small, MAX_CHUNK_BASE64_CHARS + 1, small]).map((chunk) => chunk.length),
  [1, 1, 1],
  "an oversized page goes alone, and never drags its neighbours with it",
);

assert.deepEqual(group([]), [], "no pages, no chunks");

console.log("page-chunks: ok");
