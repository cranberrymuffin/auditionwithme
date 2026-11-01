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
    // Every request header the client sends beyond the safelisted ones: a
    // header missing here fails the preflight, which iOS reports only as
    // "Load failed". x-rehearsal-grant: parse-script/parse-pages
    // (Practice.tsx, scannedScript.ts); X-TTS-Purpose: reader-audio pregen.
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, X-Rehearsal-Grant, X-TTS-Purpose",
    );
    // Response headers the client reads; cross-origin it only sees the
    // safelisted ones otherwise (useTtsPlayer.ts, useReaderAudioPregen.ts).
    res.setHeader(
      "Access-Control-Expose-Headers",
      "Retry-After, X-TTS-Current-Concurrent, X-TTS-Max-Concurrent",
    );
    res.setHeader("Access-Control-Max-Age", "86400");
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }
  return false;
}
