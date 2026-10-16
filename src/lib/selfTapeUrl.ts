import { getTapeBlob } from "./selfTapeStore";

// Module-level cache (outside React) so navigating away from a tape and back
// — or FeedbackGate and My Account both wanting the same tape's URL — reuses
// one object URL instead of re-reading the blob out of IndexedDB and minting
// a new one. Callers must not revoke the URL themselves; forgetSelfTapeUrl
// does that once, here, so the same URL can be shared safely.
type CachedTape = { blob: Blob; url: string };
const cache = new Map<string, Promise<CachedTape | null>>();

function getCachedTape(tapeId: string): Promise<CachedTape | null> {
  const cached = cache.get(tapeId);
  if (cached) return cached;
  const promise = getTapeBlob(tapeId).then((blob) =>
    blob ? { blob, url: URL.createObjectURL(blob) } : null,
  );
  cache.set(tapeId, promise);
  return promise;
}

export async function getSelfTapeUrl(tapeId: string): Promise<string | null> {
  return (await getCachedTape(tapeId))?.url ?? null;
}

/** The tape's own Blob, from the same cache — for download/share, which
 * would otherwise fetch() the object URL back into a second copy. */
export async function getSelfTapeBlob(tapeId: string): Promise<Blob | null> {
  return (await getCachedTape(tapeId))?.blob ?? null;
}

export function forgetSelfTapeUrl(tapeId: string) {
  const cached = cache.get(tapeId);
  if (!cached) return;
  cache.delete(tapeId);
  void cached.then((tape) => {
    if (tape) URL.revokeObjectURL(tape.url);
  });
}
