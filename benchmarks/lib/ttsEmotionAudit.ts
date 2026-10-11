// Markup audit for the emotiveness benchmark (benchmarks/tts-emotion.ts):
// scores what the AI director produced for each target line against the
// fixture's hand-written labels, before any audio exists. Pure, so the
// dry-run checks can exercise it.
//
// The questions it answers per configuration:
//   - how many lines were left undirected (null markup)?
//   - on lines the script gives an emotional cue, how often does the
//     director's tag family match the label's family?
//   - how varied are the tags across the set (a scene where every line is
//     "[sad]" is as wrong as one with no tags)?
//   - did neutral lines get emotional tags they shouldn't have?

export type Family =
  | "neutral" | "warm" | "sad" | "angry" | "anxious" | "playful" | "sarcastic"
  | "pleading" | "commanding" | "surprised" | "tired" | "menacing";

export type Label = {
  emotion: string;
  family: Family;
  intensity: "low" | "medium" | "high";
  cue: "none" | "dialogue" | "stage" | "parenthetical";
  reply: boolean;
};

// Every tag the director (api/casting.ts TAG_VOCABULARY), the script
// parenthetical map (src/lib/delivery.ts) and the "warm" prompt variant can
// produce, folded into the fixture's families. Non-verbal sounds and pacing
// markers are listed under the family they most often carry.
const TAG_FAMILIES: Record<string, Family> = {
  calm: "neutral", quietly: "neutral", flatly: "neutral", "matter of fact": "neutral",
  thoughtful: "neutral", deadpan: "sarcastic", "clears throat": "neutral", pause: "neutral",
  warm: "warm", gentle: "warm", tender: "warm", cheerful: "warm", softly: "warm",
  reassuring: "warm", kind: "warm", fond: "warm", affectionate: "warm",
  sad: "sad", somber: "sad", sorrowful: "sad", "resigned tone": "sad", crying: "sad",
  hurt: "sad", wistful: "sad", quiet: "sad", heavy: "sad", mournful: "sad",
  angry: "angry", annoyed: "angry", frustrated: "angry", cold: "angry", bitter: "angry",
  irritated: "angry", furious: "angry", sharp: "angry", exasperated: "angry",
  nervous: "anxious", hesitant: "anxious", hesitates: "anxious", stammers: "anxious",
  gulps: "anxious", scared: "anxious", worried: "anxious", anxious: "anxious",
  panicked: "anxious", terrified: "anxious", uneasy: "anxious", frightened: "anxious",
  playful: "playful", teasing: "playful", flirtatious: "playful", excited: "playful",
  laughs: "playful", chuckles: "playful", giggles: "playful", amused: "playful",
  laughing: "playful", howling: "playful", upbeat: "playful", bright: "playful",
  sarcastic: "sarcastic", mocking: "sarcastic", dryly: "sarcastic", dry: "sarcastic",
  wry: "sarcastic", sophisticated: "sarcastic", smug: "sarcastic",
  pleading: "pleading", desperate: "pleading", begging: "pleading",
  shouts: "commanding", commanding: "commanding", firm: "commanding", stern: "commanding",
  insistent: "commanding", screams: "commanding", urgent: "commanding",
  surprised: "surprised", shocked: "surprised", confused: "surprised", curious: "surprised",
  incredulous: "surprised", gasps: "surprised", stunned: "surprised",
  tired: "tired", resigned: "tired", weary: "tired", sighs: "tired", groggy: "tired",
  sleepy: "tired", exhausted: "tired",
  threatening: "menacing", menacing: "menacing", icy: "menacing", sinister: "menacing",
  chilling: "menacing",
};

// Families close enough that a tag from one is a reasonable read of the other.
const NEIGHBOURS: Record<Family, Family[]> = {
  neutral: [], warm: ["playful"], sad: ["tired", "pleading"], angry: ["menacing", "sarcastic"],
  anxious: ["pleading", "surprised"], playful: ["warm", "sarcastic"], sarcastic: ["playful", "angry"],
  pleading: ["sad", "anxious"], commanding: ["angry", "menacing"], surprised: ["anxious"],
  tired: ["sad"], menacing: ["angry", "commanding"],
};

/** The bracketed tags in a markup string, lower-cased, leading beat markers
 * dropped (they're timing, not tone). */
export function extractTags(markup: string | null): string[] {
  if (!markup) return [];
  return [...markup.matchAll(/\[([^\]]+)\]/g)]
    .map((match) => match[1].trim().toLowerCase())
    .filter((tag) => tag !== "short pause" && tag !== "long pause");
}

/** The family a tag belongs to, or null for a tag the table doesn't know
 * (voice-quality tags like "low tired voice" are matched on any known word). */
export function tagFamily(tag: string): Family | null {
  const direct = TAG_FAMILIES[tag];
  if (direct) return direct;
  for (const word of tag.split(/\s+/)) {
    if (TAG_FAMILIES[word]) return TAG_FAMILIES[word];
  }
  return null;
}

/** Punctuation the director may add for pacing: ellipses, em-dashes. */
export function pacingShaped(markup: string | null, original: string): boolean {
  if (!markup) return false;
  const count = (value: string) => (value.match(/…|\.\.\.|—|--/g) ?? []).length;
  return count(markup) > count(original);
}

/** CAPITALIZED words the director added for emphasis. */
export function addedEmphasis(markup: string | null, original: string): number {
  if (!markup) return 0;
  const caps = (value: string) =>
    new Set((value.match(/\b[A-Z]{2,}\b/g) ?? []).map((word) => word.toLowerCase()));
  const before = caps(original);
  return [...caps(markup)].filter((word) => !before.has(word)).length;
}

export type LineAudit = {
  id: string;
  family: Family;
  cue: Label["cue"];
  directed: boolean;
  tags: string[];
  families: (Family | null)[];
  /** Whether any tag is in the label's family or a neighbouring one; null
   * when there's no tag to judge or the line is labelled neutral. */
  familyMatch: boolean | null;
  pacing: boolean;
  emphasis: number;
  /** Any delivery shaping at all: a tag, pacing punctuation or emphasis. */
  shaped: boolean;
};

export function auditLine(id: string, label: Label, markup: string | null, original: string): LineAudit {
  const tags = extractTags(markup);
  const families = tags.map(tagFamily);
  const matches = (family: Family | null) =>
    family !== null && (family === label.family || NEIGHBOURS[label.family].includes(family));
  const familyMatch = label.family === "neutral" || tags.length === 0 ? null : families.some(matches);
  const pacing = pacingShaped(markup, original);
  const emphasis = addedEmphasis(markup, original);
  return {
    id,
    family: label.family,
    cue: label.cue,
    directed: markup !== null,
    tags,
    families,
    familyMatch,
    pacing,
    emphasis,
    shaped: tags.length > 0 || pacing || emphasis > 0,
  };
}

export type AuditSummary = {
  lines: number;
  /** Share of lines with any markup at all. */
  directedShare: number;
  /** Share of lines with a tag, pacing punctuation or emphasis. */
  shapedShare: number;
  /** Of the emotionally cued lines (label family ≠ neutral), the share left
   * with no delivery shaping at all — the flat-read risk. */
  cuedButFlat: number;
  /** Of the cued lines that got a tag, the share whose tag fits the label. */
  familyMatchRate: number | null;
  /** Of the neutral-labelled lines, the share given an emotional tag. */
  neutralOverTagged: number | null;
  /** Unique tags over total tags. */
  tagDiversity: number | null;
  tagCounts: Record<string, number>;
};

export function summarizeAudit(audits: LineAudit[]): AuditSummary {
  const cued = audits.filter((audit) => audit.family !== "neutral");
  const neutral = audits.filter((audit) => audit.family === "neutral");
  const judged = cued.filter((audit) => audit.familyMatch !== null);
  const allTags = audits.flatMap((audit) => audit.tags);
  const tagCounts: Record<string, number> = {};
  for (const tag of allTags) tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
  const share = (part: number, whole: number) => (whole ? part / whole : 0);
  return {
    lines: audits.length,
    directedShare: share(audits.filter((audit) => audit.directed).length, audits.length),
    shapedShare: share(audits.filter((audit) => audit.shaped).length, audits.length),
    cuedButFlat: share(cued.filter((audit) => !audit.shaped).length, cued.length),
    familyMatchRate: judged.length ? share(judged.filter((audit) => audit.familyMatch).length, judged.length) : null,
    neutralOverTagged: neutral.length
      ? share(neutral.filter((audit) => audit.families.some((family) => family && family !== "neutral")).length, neutral.length)
      : null,
    tagDiversity: allTags.length ? new Set(allTags).size / allTags.length : null,
    tagCounts,
  };
}

/** Wilson score interval for a win rate — small samples, so no normal
 * approximation around p̂ alone. */
export function wilson(wins: number, total: number, z = 1.96): { p: number; low: number; high: number } {
  if (total === 0) return { p: 0, low: 0, high: 0 };
  const p = wins / total;
  const denominator = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator;
  return { p, low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
}
