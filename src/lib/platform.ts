import { Capacitor } from "@capacitor/core";

/** True inside the iOS app (Capacitor), false in any browser. */
export const IS_NATIVE = Capacitor.isNativePlatform();

// The iOS app serves its bundle from capacitor://localhost, so relative
// /api paths and window.location.origin point nowhere useful there. Both
// resolve against the deployed site instead; in a browser they stay
// same-origin as before. (import.meta.env is Vite's; Node scripts under
// benchmarks/ that import this have none.)
const WEB_ORIGIN = (import.meta.env?.VITE_WEB_ORIGIN as string | undefined)?.replace(/\/$/, "");

if (IS_NATIVE && !WEB_ORIGIN) {
  console.error("VITE_WEB_ORIGIN is not set; the iOS app can't reach /api");
}

/** An /api path made absolute for the iOS app. */
export function apiUrl(path: string): string {
  return IS_NATIVE && WEB_ORIGIN ? `${WEB_ORIGIN}${path}` : path;
}

/** The origin auth emails should link back to: the deployed site, which
 * opens the iOS app through its Universal Link when installed. */
export function authRedirectOrigin(): string {
  return IS_NATIVE && WEB_ORIGIN ? WEB_ORIGIN : window.location.origin;
}
