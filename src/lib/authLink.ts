// What a Supabase email link (signup confirmation, password reset, email
// change) brought back to the page it landed on. With the PKCE flow
// (src/lib/supabase.ts) the code and errors come in the query string, while
// Supabase still reports some outcomes, like a half-finished email change,
// in the hash — so both are read.

export type AuthLink = {
  /** The one-time PKCE code. supabase-js exchanges it while starting up,
   * but only in the browser holding its verifier: a code still here with
   * no session means the link was opened on another device. */
  code: string | null;
  error: string | null;
  message: string | null;
};

export function readAuthLink(href: string): AuthLink {
  const url = new URL(href);
  const query = url.searchParams;
  const hash = new URLSearchParams(url.hash.slice(1));
  const read = (key: string) => query.get(key) || hash.get(key) || null;
  return {
    code: query.get("code"),
    error: read("error_description") ?? read("error"),
    message: read("message"),
  };
}

export function hasAuthLink(link: AuthLink): boolean {
  return Boolean(link.code || link.error || link.message);
}

/** Drops the link's parameters from the address bar, so a spent code or an
 * old message doesn't come back on reload. */
export function clearAuthLink(): void {
  window.history.replaceState(window.history.state, "", window.location.pathname);
}
