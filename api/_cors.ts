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
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }
  return false;
}
