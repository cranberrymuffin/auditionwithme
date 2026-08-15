// Audition-sides cue handling, applied to layout lines before any parsing
// strategy runs. The client (src/lib/sidesMarkup.ts) reads sides markup —
// annotation cues become sentinel lines, struck/covered text is already
// dropped — and cue words typed into the page ("START >", "< END") arrive here
// as ordinary text lines. This module normalizes both into one representation
// and trims the script to the selection the casting office marked.

import type { LayoutLineTuple } from "./_layout.js";

export const SIDES_START_SENTINEL = "⟦SIDES:START⟧";
export const SIDES_END_SENTINEL = "⟦SIDES:END⟧";
export const SIDES_NOTE_PREFIX = "⟦SIDES:NOTE:";
export const SIDES_NOTE_SUFFIX = "⟧";

// Text-layer cue lines. Arrowed forms are unambiguous; bare words only count
// in ALL CAPS so dialogue like "Stop." or a scene's "End" never matches.
const TEXT_START_CUE = /^(?:START\s*>*|>+\s*START)$/;
const TEXT_END_CUE = /^(?:<+\s*END|END\s*<*|STOP)$/;

// Sides page furniture that isn't script content.
const SIDES_JUNK: RegExp[] = [
  /^PG\s+\d+\s+OF\s+\d+$/i, // "PG 1 OF 7"
  /^\d{1,3}\s*\/\s*\d{1,3}$/, // "1/4"
  /^ROLE:\s*.+$/i, // "Role: BEVERLY"
  /^.{1,40}[-–]\s*SC\s*\d+\s*\(\s*OF\s*\d+\s*\)$/i, // "CARL - SC 1 (OF 2)"
  /^Sc(?:ene)?\.?\s*\d+$/i, // "Sc. 1"
  /^Sides by Breakdown Services\b/i,
  /^Made in Highland$/i,
];

export type SidesResult = {
  lines: LayoutLineTuple[];
  /** START/END cues were found and the selection was trimmed to them. */
  cuesApplied: boolean;
};

/**
 * Resolve sides sentinels and cue text: strip furniture, convert margin notes
 * to parenthetical cue lines, and — when START/END cues exist — keep only the
 * marked selection (multiple START…END segments supported).
 */
export function applySidesMarkup(tuples: LayoutLineTuple[]): SidesResult {
  type Marker =
    | { type: "start" | "end" }
    | { type: "note"; text: string }
    | { type: "line"; tuple: LayoutLineTuple };

  const markers: Marker[] = [];
  let hasStart = false;
  let hasEnd = false;

  for (const tuple of tuples) {
    const text = tuple[2].trim();
    if (!text) continue;
    if (text === SIDES_START_SENTINEL || TEXT_START_CUE.test(text)) {
      markers.push({ type: "start" });
      hasStart = true;
    } else if (text === SIDES_END_SENTINEL || TEXT_END_CUE.test(text)) {
      markers.push({ type: "end" });
      hasEnd = true;
    } else if (
      text.startsWith(SIDES_NOTE_PREFIX) &&
      text.endsWith(SIDES_NOTE_SUFFIX)
    ) {
      const note = text
        .slice(SIDES_NOTE_PREFIX.length, -SIDES_NOTE_SUFFIX.length)
        .trim();
      if (note) markers.push({ type: "note", text: note });
    } else if (!SIDES_JUNK.some((re) => re.test(text))) {
      markers.push({ type: "line", tuple });
    }
  }

  // With START cues, nothing is kept until a START; an END suspends keeping
  // until the next START. With only END cues, keep from the top to the first
  // END. Without either, the whole document stays.
  const cuesApplied = hasStart || hasEnd;
  let keep = !hasStart;

  const lines: LayoutLineTuple[] = [];
  const pendingNotes: string[] = [];
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i];
    if (marker.type === "start") keep = true;
    else if (marker.type === "end") keep = false;
    else if (marker.type === "note") {
      if (keep) pendingNotes.push(marker.text);
    } else if (keep) {
      if (pendingNotes.length) {
        // Anchor queued margin notes to this line's column so the layout
        // parser treats them as parenthetical/action cues, not dialogue.
        for (const note of pendingNotes.splice(0)) {
          const wrapped =
            note.startsWith("(") && note.endsWith(")") ? note : `(${note})`;
          lines.push([marker.tuple[0], marker.tuple[1], wrapped]);
        }
      }
      lines.push(marker.tuple);
    }
  }
  // Notes with no following kept line attach after the last kept line.
  for (const note of pendingNotes) {
    const wrapped =
      note.startsWith("(") && note.endsWith(")") ? note : `(${note})`;
    const last = lines[lines.length - 1];
    lines.push([last?.[0] ?? 1, last?.[1] ?? 0, wrapped]);
  }

  return { lines, cuesApplied };
}
