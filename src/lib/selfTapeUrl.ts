import { getTapeBlob } from "./selfTapeStore";

// Module-level cache (outside React) so navigating away from a tape and back
// — or FeedbackGate and My Account both wanting the same tape's URL — reuses
// one object URL instead of re-reading the blob out of IndexedDB and minting
// a new one. Callers must not revoke the URL themselves; forgetSelfTapeUrl
// does that once, here, so the same URL can be shared safely.
const cache = new Map<string, Promise<string | null>>();

export function getSelfTapeUrl(tapeId: string): Promise<string | null> {
  const cached = cache.get(tapeId);
  if (cached) return cached;
  const promise = getTapeBlob(tapeId).then((blob) =>
    blob ? URL.createObjectURL(blob) : null,
  );
  cache.set(tapeId, promise);
  return promise;
}

export function forgetSelfTapeUrl(tapeId: string) {
  const cached = cache.get(tapeId);
  if (!cached) return;
  cache.delete(tapeId);
  void cached.then((url) => {
    if (url) URL.revokeObjectURL(url);
  });
}
