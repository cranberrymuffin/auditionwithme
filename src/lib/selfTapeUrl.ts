import { supabase } from "./supabase";

// Self-tapes upload with Supabase Storage's default 1hr Cache-Control, so a
// signed URL that's reused verbatim is served straight from the browser's
// own HTTP cache on a repeat request — no bytes cross the network again.
// Module-level (outside React) so the cache survives component remounts:
// navigating away from /account and back, or FeedbackGate and MyAccount
// both wanting the same tape's URL, reuse one signed URL instead of minting
// a fresh token each time and busting that cache.
const SIGNED_URL_TTL_SECONDS = 3600;
const REUSE_WINDOW_MS = 55 * 60 * 1000;

const cache = new Map<string, { promise: Promise<string | null>; fetchedAt: number }>();

export function getSelfTapeUrl(storagePath: string): Promise<string | null> {
  const cached = cache.get(storagePath);
  if (cached && Date.now() - cached.fetchedAt < REUSE_WINDOW_MS) {
    return cached.promise;
  }
  const promise = supabase.storage
    .from("self-tapes")
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS)
    .then(({ data }) => data?.signedUrl ?? null);
  cache.set(storagePath, { promise, fetchedAt: Date.now() });
  return promise;
}

export function forgetSelfTapeUrl(storagePath: string) {
  cache.delete(storagePath);
}
