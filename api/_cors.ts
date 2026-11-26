import type { VercelRequest, VercelResponse } from "@vercel/node";

// The iOS app (Capacitor) serves the web bundle from capacitor://localhost,
// so its /api calls are cross-origin; the web app is same-origin and sends
// no Origin worth matching. Auth is the Bearer token, never cookies, so no
// credentials mode is needed.
const NATIVE_ORIGINS = new Set(["capacitor://localhost"]);

/** Sets CORS headers for the native app and answers its preflight. Returns
 * true when the request was a preflight and the handler should stop. */
export function handleCors(req: VercelRequest, res: VercelResponse): boolean {
  const origin = req.headers.origin;
  if (origin && NATIVE_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    // x-rehearsal-grant carries the signed rehearsal grant on parse calls
    // (parse-script, parse-pages) and X-TTS-Purpose marks pre-generation
    // requests (tts, sts); a header missing here fails the preflight and
    // WebKit reports the request as "Load failed".
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, x-rehearsal-grant, X-TTS-Purpose",
    );
    // Cross-origin scripts can only read response headers listed here. The
    // player waits out Retry-After and pre-generation paces itself on the
    // concurrency pair (useTtsPlayer.ts, useReaderAudioPregen.ts); without
    // them the native app falls back to guessing.
    res.setHeader(
      "Access-Control-Expose-Headers",
      "Retry-After, X-TTS-Current-Concurrent, X-TTS-Max-Concurrent, X-TTS-Model, X-TTS-Pregen-Hold, Server-Timing",
    );
    res.setHeader("Access-Control-Max-Age", "86400");
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }
  return false;
}
