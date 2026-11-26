// How scanned pages are grouped into /api/parse-pages requests. Pure, so a
// check can run it without a browser (benchmarks/checks/page-chunks.ts).

// Small chunks keep each response short — long verbatim transcriptions trip
// the API's content filter, and shorter chunks parallelize better.
export const PAGES_PER_CHUNK = 5;
// The platform refuses request bodies over 4.5 MB before the function runs;
// dense, high-resolution scans can pass that in fewer than five pages. Base64
// characters are one byte each on the wire; the margin covers the JSON
// around them.
export const MAX_CHUNK_BASE64_CHARS = 3.5 * 1024 * 1024;

/** Whether a chunk holding `pageCount` pages (`chars` of base64 in all)
 * must be sent before a page of `nextChars` joins it. A lone oversized page
 * still goes out by itself: there's nothing smaller to send. */
export function chunkIsFull(pageCount: number, chars: number, nextChars: number): boolean {
  if (pageCount === 0) return false;
  return pageCount >= PAGES_PER_CHUNK || chars + nextChars > MAX_CHUNK_BASE64_CHARS;
}
