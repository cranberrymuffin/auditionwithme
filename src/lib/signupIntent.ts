// Where a visitor was headed when they signed up, kept across the email
// confirmation: the link opens a fresh page (often a new tab), where router
// state is gone. Login.tsx reads it back once the link has signed them in.
const KEY = "awm:signupIntent";
// A confirmation link acted on days later shouldn't replay a stale intent.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type AuthRedirect = { from?: { pathname?: string }; intent?: string } | null;

export function rememberSignupIntent(state: AuthRedirect) {
  try {
    if (!state?.from?.pathname && !state?.intent) {
      localStorage.removeItem(KEY);
      return;
    }
    localStorage.setItem(
      KEY,
      JSON.stringify({ pathname: state.from?.pathname, intent: state.intent, at: Date.now() }),
    );
  } catch {
    // No storage: the confirmed visitor lands on Home instead.
  }
}

/** The remembered destination, read once. */
export function takeSignupIntent(): AuthRedirect {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    localStorage.removeItem(KEY);
    const saved = JSON.parse(raw) as { pathname?: unknown; intent?: unknown; at?: unknown };
    if (typeof saved.at !== "number" || Date.now() - saved.at > MAX_AGE_MS) return null;
    // Only ever an in-app path: this value came from storage, not the router.
    const pathname =
      typeof saved.pathname === "string" && saved.pathname.startsWith("/") && !saved.pathname.startsWith("//")
        ? saved.pathname
        : undefined;
    return {
      from: pathname ? { pathname } : undefined,
      intent: typeof saved.intent === "string" ? saved.intent : undefined,
    };
  } catch {
    return null;
  }
}
