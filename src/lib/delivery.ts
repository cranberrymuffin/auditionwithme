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
  beat: "pause",
  pause: "pause",
  pauses: "pause",
};

// Parentheticals that are staging, not delivery: "(to JOHN)", "(off her look)",
// "(into phone)", "(re: the letter)", continuity markers.
const NON_DELIVERY_PREFIX = /^(to |into |off |re[:.]|cont|o\.s|v\.o|then )/;

function tagFromDirection(direction: string): string | undefined {
  const normalized = direction
    .replace(/^\(|\)$/g, "")
    .trim()
    .toLowerCase();
  if (!normalized || NON_DELIVERY_PREFIX.test(normalized)) return undefined;
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
