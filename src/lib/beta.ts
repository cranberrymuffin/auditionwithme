// Beta-testing switch: pricing/subscriptions are off, rehearsals are
// unlimited, and every audition requires a piece of feedback before the
// user can keep using the app (see FeedbackGate.tsx). Set
// VITE_BETA_TESTING=false to turn on the paywall (free trial, then a
// subscription — see src/lib/plan.ts).
//
// Read from Vite's import.meta.env in the browser and the local dev API,
// and from process.env in a deployed Vercel function, which has no
// import.meta.env. Anything but "false" keeps beta on, so an environment
// missing the variable never switches the paywall on by accident.
const env =
  (import.meta as { env?: Record<string, string | undefined> }).env ??
  (globalThis as { process?: { env: Record<string, string | undefined> } })
    .process?.env ??
  {};

export const IS_BETA_TESTING = env.VITE_BETA_TESTING !== "false";
