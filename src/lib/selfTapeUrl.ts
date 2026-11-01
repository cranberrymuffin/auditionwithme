import { Capacitor } from "@capacitor/core";
import { IS_NATIVE } from "./platform";
import { getTapeBlob, getTapeFile, moveTapeBlobToFile } from "./selfTapeStore";

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
  if (IS_NATIVE) {
    const file = await nativeTapeFile(tapeId);
    return file ? Capacitor.convertFileSrc(file.path) : null;
  }
  return (await getCachedTape(tapeId))?.url ?? null;
}

/** iOS app: the take's file — moving an older in-app take out of IndexedDB
 * on first use — or null if there's none to play. The web view streams the
 * file through its capacitor:// URL; the video never becomes a Blob. */
const nativeFiles = new Map<string, Promise<{ path: string; mimeType: string } | null>>();
export function nativeTapeFile(tapeId: string): Promise<{ path: string; mimeType: string } | null> {
  let file = nativeFiles.get(tapeId);
  if (!file) {
    file = getTapeFile(tapeId).then((stored) => stored ?? moveTapeBlobToFile(tapeId));
    nativeFiles.set(tapeId, file);
  }
  return file;
}

/** The tape's own Blob, from the same cache — for download/share, which
 * would otherwise fetch() the object URL back into a second copy. */
export async function getSelfTapeBlob(tapeId: string): Promise<Blob | null> {
  return (await getCachedTape(tapeId))?.blob ?? null;
}

export function forgetSelfTapeUrl(tapeId: string) {
  nativeFiles.delete(tapeId);
  const cached = cache.get(tapeId);
  if (!cached) return;
  cache.delete(tapeId);
  void cached.then((tape) => {
    if (tape) URL.revokeObjectURL(tape.url);
  });
}
