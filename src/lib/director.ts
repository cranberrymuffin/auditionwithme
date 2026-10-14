// Version of the AI director's prompt + tag vocabulary (DIRECTOR_PROMPT and
// TAG_VOCABULARY in api/casting.ts). Saved scripts store the version their
// delivery tags were generated under; Practice.tsx re-runs direct-lines for
// any script whose stored version is older, so a prompt change actually
// reaches scripts directed before it. Rows saved before versioning existed
// have no version and count as stale. Bump this with every prompt change.
//   1 — original "skilled actor" prompt (implicit, never stored)
//   2 — reader-first prompt with grounded tags (beta tone feedback, Oct 2026)
//   3 — sees each line's stage directions; may lead a line with a
//       [short pause]/[long pause] beat marker (beta "no pauses" feedback)
//   4 — hesitations inside a line are ellipses, not a [pause] tag (Eleven v4
//       documents punctuation for pauses, not pause tags)
export const DIRECTOR_VERSION = 4;
