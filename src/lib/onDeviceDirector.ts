import type { Step } from "../types";
import { leadingDirections } from "./delivery";
import { sanitizePerformance } from "./direction";
import { TAG_VOCABULARY } from "./director";
import { AppleAI } from "./native/appleAI";
import { normalizeSpeaker } from "./speaker";

// The AI director on Apple's on-device model (iOS 26 app), in place of the
// Sonnet call in api/casting.ts directLines. Same job, same output (one
// markup string or null per line, checked by sanitizePerformance), but the
// on-device model is small: a ~4k-token context and much less nuance. So the
// prompt is a condensed DIRECTOR_PROMPT, the scene goes in short chunks with
// a few earlier rows as context, and the model only returns the rows it
// marks up (most rows need nothing).
//
// Off unless VITE_ON_DEVICE_DIRECTOR=true: it only replaces the cloud
// director once the on-device check on the Admin page (directorCompare.ts)
// and a listen say its reads hold up.

export const ON_DEVICE_DIRECTOR_ENABLED = import.meta.env?.VITE_ON_DEVICE_DIRECTOR === "true";

export type DirectorLine = { speaker: string; text: string; direction?: string };

/** A script's steps as director input — what Practice.tsx sends either
 * director, with each line's stage directions so it can judge beats. */
export function directorLines(steps: Step[]): DirectorLine[] {
  return steps.map((step) => ({
    speaker: normalizeSpeaker(step.speaker),
    text: step.verbalLine,
    direction: leadingDirections(step.content) || undefined,
  }));
}

/** Rows directed per call, and earlier rows shown as context only. */
const CHUNK_ROWS = 16;
const CONTEXT_ROWS = 4;
const MAX_DIRECTION_CHARS = 160;

export const ON_DEVICE_DIRECTOR_INSTRUCTIONS = `You are a voice director for an AI scene partner who reads lines opposite an actor recording an audition. The reader is grounded and conversational, supports the actor, never upstages them, and plays one notch below what the scene implies.

For each row that needs it, return the row number and that row's exact words with performance markup. Leave out rows that are fine as written — most rows are. A scene where every line is marked up sounds like melodrama.

Markup you may use:
- An audio tag in square brackets at the start of the line: ${TAG_VOCABULARY.join(", ")}. At most one per line, or two on a multi-sentence line whose feeling shifts at a sentence boundary.
- Ellipses (…) for a hesitation or trailing thought, em-dashes (—) for an interruption or pivot.
- CAPITALS on one word the reader would genuinely stress, rarely.
- "[short pause]" or "[long pause]" as the very first thing, only when the script calls for a beat: an explicit (beat), (pause) or (silence), a stage direction implying a silent reaction before speaking, or answering bad news or a revelation. Quick replies get no beat.

Rules:
- Never add, remove, reorder or respell words. Only tags, punctuation and capitals may change.
- {stage: …} is the script's stage direction before the line: context only, never copy it.
- Tags describe how the voice sounds, never actions or sound effects.
- Rows marked "context" are earlier lines for reference only; never return them.

Example rows:
3| BEN: Yeah.
4| {stage: (a long beat)} BEN: It's back. The cancer's back.
5| ANNA: I know what I said. Just forget it.
Example answer: row 4 "[long pause] It's back. The cancer's back.", row 5 "I know what I said. [sighs] Just forget it."`;

function row(line: DirectorLine, index: number, context: boolean): string {
  // Brackets and braces stripped so script text can't pose as markup or as
  // our own {stage: …} wrapper (same defense as api/casting.ts).
  const direction = (line.direction ?? "")
    .replace(/[{}[\]<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DIRECTION_CHARS);
  return `${index}| ${context ? "context " : ""}${direction ? `{stage: ${direction}} ` : ""}${line.speaker || "—"}: ${line.text}`;
}

/** The prompt for rows [start, end), with up to CONTEXT_ROWS earlier rows. */
export function chunkPrompt(lines: DirectorLine[], start: number, end: number): string {
  const rows: string[] = [];
  for (let i = Math.max(0, start - CONTEXT_ROWS); i < end; i++) rows.push(row(lines[i], i, i < start));
  return `Scene rows:\n${rows.join("\n")}`;
}

/** Row ranges to direct, one call each. */
export function chunkRanges(count: number): [number, number][] {
  const ranges: [number, number][] = [];
  for (let start = 0; start < count; start += CHUNK_ROWS) ranges.push([start, Math.min(count, start + CHUNK_ROWS)]);
  return ranges;
}

/**
 * Folds one chunk's answer into `tags`. Rows outside the chunk (context rows,
 * or numbers the model made up) are ignored, and markup that changes the
 * spoken words is dropped — the line reads unadorned, as with the cloud
 * director. Returns how many entries the model returned and how many were
 * kept, for the on-device check.
 */
export function applyChunk(
  tags: (string | null)[],
  lines: DirectorLine[],
  [start, end]: [number, number],
  answer: { row: number; markup: string }[],
): { returned: number; kept: number } {
  let kept = 0;
  for (const { row: index, markup } of answer) {
    if (!Number.isInteger(index) || index < start || index >= end || !lines[index].text.trim()) continue;
    const clean = sanitizePerformance(markup, lines[index].text);
    // Markup identical to the line is the model saying "fine as written".
    if (clean && clean !== lines[index].text.trim()) {
      tags[index] = clean;
      kept++;
    }
  }
  return { returned: answer.length, kept };
}

/** Directs every line on device. Throws if any chunk fails, so the caller
 * can hand the whole script to the cloud director instead. */
export async function directLinesOnDevice(
  lines: DirectorLine[],
): Promise<{ tags: (string | null)[]; returned: number; kept: number }> {
  const tags: (string | null)[] = lines.map(() => null);
  let returned = 0;
  let kept = 0;
  for (const range of chunkRanges(lines.length)) {
    // A chunk of only stage-direction rows has nothing to direct.
    if (!lines.slice(range[0], range[1]).some((line) => line.text.trim())) continue;
    const answer = await AppleAI.directLines({
      instructions: ON_DEVICE_DIRECTOR_INSTRUCTIONS,
      prompt: chunkPrompt(lines, range[0], range[1]),
    });
    const counts = applyChunk(tags, lines, range, answer.lines);
    returned += counts.returned;
    kept += counts.kept;
  }
  return { tags, returned, kept };
}
