import type { ContentLine } from "../types";

// Screenplay parenthetical → Eleven v3 audio tag. Explicit direction in the
// script always outranks the AI director's inferred tag (see Rehearsal.tsx).
const PARENTHETICAL_TAGS: Record<string, string> = {
  angry: "angry",
  angrily: "angry",
  furious: "angry",
  furiously: "angry",
  annoyed: "annoyed",
  irritated: "annoyed",
  whisper: "whispers",
  whispers: "whispers",
  whispering: "whispers",
  "sotto voce": "whispers",
  quietly: "whispers",
  softly: "softly",
  shouting: "shouts",
  shouts: "shouts",
  yelling: "shouts",
  yells: "shouts",
  screaming: "screams",
  laughing: "laughs",
  laughs: "laughs",
  chuckling: "chuckles",
  giggling: "giggles",
  crying: "crying",
  sobbing: "crying",
  tearful: "crying",
  "through tears": "crying",
  sighing: "sighs",
  sighs: "sighs",
  sarcastic: "sarcastic",
  sarcastically: "sarcastic",
  dryly: "sarcastic",
  deadpan: "deadpan",
  nervous: "nervous",
  nervously: "nervous",
  anxious: "nervous",
  hesitant: "hesitant",
  hesitates: "hesitant",
  excited: "excited",
  excitedly: "excited",
  eagerly: "excited",
  sad: "sad",
  sadly: "sad",
  somber: "somber",
  mournfully: "somber",
  happily: "cheerful",
  cheerful: "cheerful",
  cheerfully: "cheerful",
  warmly: "warm",
  gently: "gentle",
  tenderly: "tender",
  coldly: "cold",
  icily: "cold",
  flatly: "deadpan",
  scared: "scared",
  frightened: "scared",
  terrified: "terrified",
  panicked: "panicked",
  pleading: "pleading",
  begging: "pleading",
  desperate: "desperate",
  desperately: "desperate",
  mocking: "mocking",
  mockingly: "mocking",
  teasing: "teasing",
  playful: "playful",
  playfully: "playful",
  flirting: "flirtatious",
  flirtatiously: "flirtatious",
  threatening: "threatening",
  menacing: "threatening",
  drunk: "drunk",
  slurring: "drunk",
  tired: "tired",
  exhausted: "tired",
  wearily: "tired",
  surprised: "surprised",
  shocked: "shocked",
  confused: "confused",
  curious: "curious",
};

// Explicit beats in the script — "(beat)", "(a long pause)", or an action
// line that's just "Beat." / "Silence." — are timing, not tone: they become a
// client-side delay before the reader speaks (src/lib/readerLines.ts), never a
// "[pause]" tag baked into the audio. Long ones get the longer delay.
const SHORT_BEAT_DIRECTION = /^(a )?(beat|pause|pauses|short pause|brief pause|moment|small beat|short beat)$/;
const LONG_BEAT_DIRECTION = /^(a )?(long|longer|extended|very long) (beat|pause|moment|silence)$|^(a )?(silence|beat of silence|pregnant pause)$/;

export type ReaderBeat = "short" | "long";

function normalizeDirection(direction: string): string {
  return direction
    .trim()
    .replace(/^\(|\)$/g, "")
    .trim()
    .toLowerCase()
    .replace(/[.!…]+$/, "")
    .trim();
}

function beatFromDirection(direction: string): ReaderBeat | undefined {
  const normalized = normalizeDirection(direction);
  if (LONG_BEAT_DIRECTION.test(normalized)) return "long";
  if (SHORT_BEAT_DIRECTION.test(normalized)) return "short";
  return undefined;
}

// Parentheticals that are staging, not delivery: "(to JOHN)", "(off her look)",
// "(into phone)", "(re: the letter)", continuity markers.
const NON_DELIVERY_PREFIX = /^(to |into |off |re[:.]|cont|o\.s|v\.o|then )/;

function tagFromDirection(direction: string): string | undefined {
  const normalized = direction
    .replace(/^\(|\)$/g, "")
    .trim()
    .toLowerCase();
  if (!normalized || NON_DELIVERY_PREFIX.test(normalized)) return undefined;
  if (beatFromDirection(direction)) return undefined;
  const mapped = PARENTHETICAL_TAGS[normalized];
  if (mapped) return mapped;
  // Unknown single-word directions ("(wistful)") pass through — v3 handles
  // free-form tags reasonably, and one word is unlikely to be staging.
  if (/^[a-z]{3,16}$/.test(normalized)) return normalized;
  return undefined;
}

// Mirrors api/_direction.ts — the words actually spoken once bracket tags and
// punctuation are stripped.
function spokenWords(value: string): string {
  return value
    .replace(/\[[^\]]*\]/g, " ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Whether a stored AI-director entry is full performance markup of the line
 * (inline tags + pacing punctuation) rather than a legacy single-word tag.
 * Scripts directed before the markup upgrade saved bare tags like "angry";
 * those never speak the line's words, so this cleanly splits the formats.
 */
export function isPerformanceMarkup(direction: string, lineText: string): boolean {
  return direction.includes("[") || spokenWords(direction) === spokenWords(lineText);
}

/** First delivery-style parenthetical in a step's content, as a v3 audio tag. */
export function deliveryTagFromContent(content: ContentLine[]): string | undefined {
  for (const line of content) {
    if (line.kind !== "nonverbal") continue;
    const tag = tagFromDirection(line.text);
    if (tag) return tag;
  }
  return undefined;
}

/** An explicit beat written before a step's first spoken words — a
 * parenthetical or a "Beat."-style action line. Mid-speech beats are
 * ignored: delaying the start of the line would put the beat in the wrong
 * place, and the words around it can't be split without changing the
 * request. */
export function beatFromContent(content: ContentLine[]): ReaderBeat | undefined {
  let beat: ReaderBeat | undefined;
  for (const line of content) {
    if (line.kind === "verbal") break;
    const found = beatFromDirection(line.text);
    if (found === "long") return "long";
    beat = beat ?? found;
  }
  return beat;
}

// A leading "[short pause]" / "[long pause]" the AI director puts on a line's
// markup when the scene calls for a beat before the reader answers
// (DIRECTOR_PROMPT in api/casting.ts). Only at the very start; the same tags
// mid-line stay in the text as ordinary v3 pacing.
const LEADING_BEAT_MARKER = /^\s*\[(short|long) pause\]\s*/i;

/** Splits a director's leading beat marker off its markup. */
export function splitLeadingBeat(markup: string): { beat: ReaderBeat | undefined; rest: string } {
  const match = LEADING_BEAT_MARKER.exec(markup);
  if (!match) return { beat: undefined, rest: markup };
  return { beat: match[1].toLowerCase() as ReaderBeat, rest: markup.slice(match[0].length) };
}

// Per-line cap on the stage directions sent to the AI director; api/casting.ts
// clips again server-side.
const MAX_DIRECTION_CHARS = 200;

/** The stage directions and parentheticals before a step's first spoken
 * words, joined and clipped — sent to the AI director (Practice.tsx) so it
 * can judge whether the line wants a beat. Empty when there are none. */
export function leadingDirections(content: ContentLine[]): string {
  const directions: string[] = [];
  for (const line of content) {
    if (line.kind === "verbal") break;
    directions.push(line.text.trim());
  }
  const joined = directions.filter(Boolean).join(" ").replace(/\s+/g, " ");
  return joined.length > MAX_DIRECTION_CHARS ? `${joined.slice(0, MAX_DIRECTION_CHARS - 1)}…` : joined;
}
