import { Capacitor } from "@capacitor/core";
import { getTapeBlob, getTapeFile } from "./selfTapeStore";

// Module-level cache (outside React) so navigating away from a tape and back
// — or FeedbackGate and My Account both wanting the same tape's URL — reuses
// one object URL instead of re-reading the blob out of IndexedDB and minting
// a new one. Callers must not revoke the URL themselves; forgetSelfTapeUrl
// does that once, here, so the same URL can be shared safely.
//
// Takes recorded natively in the iOS app are files, not Blobs: their URL is
// the file's capacitor:// address, which the web view streams from disk.
type CachedTape = { url: string; blob: Blob | null; file: boolean };
const cache = new Map<string, Promise<CachedTape | null>>();

function getCachedTape(tapeId: string): Promise<CachedTape | null> {
  const cached = cache.get(tapeId);
  if (cached) return cached;
  const promise = getTapeFile(tapeId).then(async (file) => {
    if (file) return { url: Capacitor.convertFileSrc(file.path), blob: null, file: true };
    const blob = await getTapeBlob(tapeId);
    return blob ? { url: URL.createObjectURL(blob), blob, file: false } : null;
  });
  cache.set(tapeId, promise);
  return promise;
}

export async function getSelfTapeUrl(tapeId: string): Promise<string | null> {
  return (await getCachedTape(tapeId))?.url ?? null;
}

/** The tape as a Blob, for download/share. A browser take's comes from the
 * same cache (no second copy); a native take's file is read only now. */
export async function getSelfTapeBlob(tapeId: string): Promise<Blob | null> {
  const tape = await getCachedTape(tapeId);
  if (!tape) return null;
  if (tape.blob) return tape.blob;
  const response = await fetch(tape.url);
  return response.ok ? response.blob() : null;
}

export function forgetSelfTapeUrl(tapeId: string) {
  const cached = cache.get(tapeId);
  if (!cached) return;
  cache.delete(tapeId);
  void cached.then((tape) => {
    if (tape && !tape.file) URL.revokeObjectURL(tape.url);
  });
}
