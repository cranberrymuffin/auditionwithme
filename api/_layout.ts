// Deterministic screenplay parsing from PDF text layout. Screenplay formatting
// encodes line roles in indentation (action at the left margin, dialogue
// indented, speaker names further, transitions right-aligned), so x-coordinates
// classify every line without a model call. Two layout variants are supported:
//
//   - fixed-column: speaker names share one x position (standard screenplays)
//   - centered:     speaker names are centered, so x varies with name length
//                   (published/book editions)
//
// Both feed the same step builder via a per-line classifier, so adding another
// variant means writing one more classifier. Cluster positions are derived per
// document rather than hardcoded, so nonstandard margins still work.
//
// This is one strategy in the parse-script chain: if the document doesn't
// exhibit screenplay layout, parseScreenplayLayout returns null and the caller
// falls through to the next strategy (labeled-text classifier, full model).

import {
  type ParsedStep,
  type StepContent,
  splitSpeech,
} from "./_screenplay.js";

/** [page, x, text] — the compact wire format the client sends. */
export type LayoutLineTuple = [number, number, string];

type Line = { page: number; x: number; text: string };

const X_TOLERANCE = 8;
const MIN_SPEECHES = 10;
const PAGE_NUMBER = /^-?\d{1,4}\.?-?$/;
const CONTINUATION_MARKER = /^\(\s*(MORE|CONT'?D|CONTINUED)\s*\)$/i;
const CONTD_SUFFIX = /\((CONT'?D|CONTINUED)\)/i;
const HEADING =
  /^(INT|EXT|INT\/EXT|I\/E|FADE|CUT|DISSOLVE|SMASH|SCENE|ACT|MONTAGE|TITLE)\b/i;

function normalizeLabel(label: string): string {
  return label
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/[:.]\s*$/, "")
    .trim();
}

/** Mostly-uppercase short line — a speaker name, transition, or heading. */
function isCapsShort(text: string): boolean {
  if (text.length > 40) return false;
  const stripped = normalizeLabel(text);
  if (!stripped || stripped.length > 32) return false;
  return /\p{Lu}/u.test(stripped) && !/\p{Ll}/u.test(stripped);
}

// ── Step builder shared by all layout variants ──

type LineClass =
  | { type: "speaker"; label: string; contd: boolean }
  | { type: "dialogue" }
  | { type: "paren" }
  | { type: "action" }
  | { type: "skip" };

type Classifier = (line: Line, index: number) => LineClass;

function buildLayoutSteps(
  lines: Line[],
  classify: Classifier,
): {
  steps: ParsedStep[];
  characters: string[];
} {
  const steps: ParsedStep[] = [];
  let pendingDirections: { text: string; page: number }[] = [];
  type Part = { kind: "dialogue" | "paren"; text: string };
  let current: { speaker: string; leadIns: string[]; parts: Part[] } | null =
    null;

  const flush = () => {
    if (!current) return;
    const content: StepContent[] = current.leadIns.map((text) => ({
      kind: "nonverbal",
      text,
    }));
    const verbalParts: string[] = [];
    let buffer: string[] = [];
    const emitBuffer = () => {
      if (!buffer.length) return;
      const speech = splitSpeech(buffer.join(" "));
      content.push(...speech.content);
      if (speech.verbalLine) verbalParts.push(speech.verbalLine);
      buffer = [];
    };
    for (const part of current.parts) {
      if (part.kind === "dialogue") buffer.push(part.text);
      else {
        emitBuffer();
        content.push({ kind: "nonverbal", text: part.text });
      }
    }
    emitBuffer();
    if (content.length) {
      steps.push({
        speaker: current.speaker,
        verbalLine: verbalParts.join(" "),
        content,
      });
    }
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const text = line.text;
    // Page furniture — skip without closing the open speech, so dialogue that
    // wraps across a page boundary stays one step.
    if (PAGE_NUMBER.test(text) || CONTINUATION_MARKER.test(text)) continue;

    const cls = classify(line, i);
    switch (cls.type) {
      case "speaker": {
        // "NAME (CONT'D)" after a page break continues the same speech.
        if (current && current.speaker === cls.label && cls.contd) break;
        flush();
        // Only carry directions from this page or the previous one — anything
        // older is front matter / scene filler, not setup for this speech. The
        // title page (page 1) never attaches unless the speech starts there.
        current = {
          speaker: cls.label,
          leadIns: pendingDirections
            .filter(
              (d) =>
                d.page >= line.page - 1 && !(d.page === 1 && line.page > 1),
            )
            .map((d) => d.text),
          parts: [],
        };
        pendingDirections = [];
        break;
      }
      case "paren":
        if (current) current.parts.push({ kind: "paren", text });
        else pendingDirections.push({ text, page: line.page });
        break;
      case "dialogue":
        if (current) current.parts.push({ kind: "dialogue", text });
        else pendingDirections.push({ text, page: line.page });
        break;
      case "skip":
        break;
      case "action":
        flush();
        pendingDirections.push({ text, page: line.page });
        break;
    }
  }
  flush();

  if (pendingDirections.length && steps.length) {
    steps[steps.length - 1].content.push(
      ...pendingDirections.map((d): StepContent => ({
        kind: "nonverbal",
        text: d.text,
      })),
    );
  }

  // Characters = labels that actually speak, main roles first. Caps furniture
  // that slipped into a speaker slot ("END OF SHOW") never speaks, so it's
  // filtered here and its steps demoted to unnamed nonverbal steps.
  const verbalCounts = new Map<string, number>();
  for (const step of steps) {
    if (step.verbalLine.trim()) {
      verbalCounts.set(step.speaker, (verbalCounts.get(step.speaker) ?? 0) + 1);
    }
  }
  const characters = [...verbalCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);
  for (const step of steps) {
    if (!verbalCounts.has(step.speaker)) step.speaker = "";
  }

  return { steps, characters };
}

// ── Variant 1: fixed-column screenplay layout ──

type Cluster = {
  x: number;
  count: number;
  caps: number;
  followedByLeft: number;
};

function classifyFixed(lines: Line[], minSpeeches: number): Classifier | null {
  const clusters: Cluster[] = [];
  const clusterOf = (x: number): Cluster => {
    let cluster = clusters.find((c) => Math.abs(c.x - x) <= X_TOLERANCE);
    if (!cluster) {
      cluster = { x, count: 0, caps: 0, followedByLeft: 0 };
      clusters.push(cluster);
    }
    return cluster;
  };
  for (let i = 0; i < lines.length; i++) {
    const cluster = clusterOf(lines[i].x);
    cluster.count++;
    if (isCapsShort(lines[i].text)) {
      cluster.caps++;
      const next = lines[i + 1];
      if (next && next.x < lines[i].x - X_TOLERANCE) cluster.followedByLeft++;
    }
  }

  // Speaker column: predominantly caps-short lines followed by more-left
  // lines (their dialogue). Transitions are caps too, but nothing sits
  // left-indented under them as consistently.
  const speakerCluster = clusters
    .filter(
      (c) =>
        c.count >= minSpeeches &&
        c.caps / c.count >= 0.6 &&
        c.followedByLeft / c.count >= 0.5,
    )
    .sort((a, b) => b.count - a.count)[0];
  if (!speakerCluster) return null;
  const speakerX = speakerCluster.x;

  // Dialogue column: most common x directly under speakers (excluding
  // parentheticals). Parenthetical column: same, for "(" starters.
  const successorCounts = new Map<number, number>();
  const parenCounts = new Map<number, number>();
  for (let i = 0; i < lines.length - 1; i++) {
    if (
      Math.abs(lines[i].x - speakerX) > X_TOLERANCE ||
      !isCapsShort(lines[i].text)
    )
      continue;
    const next = lines[i + 1];
    if (next.x >= lines[i].x - X_TOLERANCE) continue;
    const target = next.text.startsWith("(") ? parenCounts : successorCounts;
    const key = clusterOf(next.x).x;
    target.set(key, (target.get(key) ?? 0) + 1);
  }
  const modeOf = (counts: Map<number, number>): number | null =>
    [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const dialogueX = modeOf(successorCounts);
  if (dialogueX === null || dialogueX >= speakerX) return null;
  const parenX = modeOf(parenCounts);

  const near = (x: number, target: number | null) =>
    target !== null && Math.abs(x - target) <= X_TOLERANCE;

  return (line) => {
    if (near(line.x, speakerX) && isCapsShort(line.text)) {
      const label = normalizeLabel(line.text);
      if (label)
        return { type: "speaker", label, contd: CONTD_SUFFIX.test(line.text) };
    }
    if (
      line.text.startsWith("(") &&
      (near(line.x, parenX) ||
        (line.x > dialogueX - X_TOLERANCE && line.x < speakerX))
    ) {
      return { type: "paren" };
    }
    if (near(line.x, dialogueX)) return { type: "dialogue" };
    // Right of the speaker column: transitions, artifacts — skip entirely.
    if (line.x > speakerX + X_TOLERANCE) return { type: "skip" };
    return { type: "action" };
  };
}

// ── Variant 2: centered speaker labels (published/book editions) ──
// Speaker x varies with name length, so classify per line: an indented
// caps-short line (not a heading/transition) followed by indented text is a
// speaker; indented non-caps lines are dialogue; margin lines are action.

function classifyCentered(lines: Line[]): Classifier | null {
  // Action margin: the leftmost x cluster carrying a substantial share of lines.
  const counts = new Map<number, number>();
  for (const line of lines) {
    const key =
      [...counts.keys()].find((x) => Math.abs(x - line.x) <= X_TOLERANCE) ??
      line.x;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const threshold = Math.max(20, lines.length * 0.1);
  const actionX = [...counts.entries()]
    .filter(([, count]) => count >= threshold)
    .sort((a, b) => a[0] - b[0])[0]?.[0];
  if (actionX === undefined) return null;
  const indented = (x: number) => x > actionX + 2.5 * X_TOLERANCE;

  return (line, index) => {
    if (!indented(line.x)) return { type: "action" };
    const text = line.text;
    if (isCapsShort(text)) {
      if (!HEADING.test(text) && !/[:.]$/.test(text)) {
        // A speaker introduces indented speech on the next content line.
        const next = lines[index + 1];
        if (next && indented(next.x) && !isCapsShort(next.text)) {
          const label = normalizeLabel(text);
          if (label)
            return { type: "speaker", label, contd: CONTD_SUFFIX.test(text) };
        }
      }
      // Indented caps that isn't a speaker: transition ("FADE TO BLACK:"),
      // heading, or artifact — never dialogue.
      return { type: "skip" };
    }
    if (text.startsWith("(")) return { type: "paren" };
    return { type: "dialogue" };
  };
}

/**
 * Parse screenplay-formatted layout lines into rehearsal steps, or return null
 * when the document doesn't look like an indent-formatted screenplay. Tries
 * each layout variant and keeps the one that explains more of the script.
 *
 * `relaxed` lowers the statistical minimums — used for cue-trimmed audition
 * sides, where a valid selection can be a single short scene.
 */
export function parseScreenplayLayout(
  tuples: LayoutLineTuple[],
  options?: { relaxed?: boolean },
): {
  steps: ParsedStep[];
  characters: string[];
} | null {
  const minLines = options?.relaxed ? 20 : 50;
  const minSpeeches = options?.relaxed ? 4 : MIN_SPEECHES;
  const lines: Line[] = tuples
    .map(([page, x, text]) => ({ page, x, text: String(text).trim() }))
    .filter((line) => line.text);
  if (lines.length < minLines) return null;

  const results = [classifyFixed(lines, minSpeeches), classifyCentered(lines)]
    .filter((classifier): classifier is Classifier => classifier !== null)
    .map((classifier) => buildLayoutSteps(lines, classifier))
    .filter(
      (result) =>
        result.steps.length >= minSpeeches && result.characters.length > 0,
    );
  if (!results.length) return null;

  // Prefer the variant that recovered the most speeches — a wrong variant
  // misses most speaker lines and yields far fewer steps.
  return results.sort((a, b) => b.steps.length - a.steps.length)[0];
}

// ── Cleaning: deterministic junk removal applied before every strategy. ──
// Extensible: add a regex to JUNK_LINES or a token to the mojibake profile.

// Publishing/scan artifacts that aren't script content.
const JUNK_LINES: RegExp[] = [
  /\.indd\s+\d+/i, // InDesign footer ("Rang De Basanti_1.indd 47")
  /^\d{1,2}\/\d{1,2}\/\d{2,4}\s+\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?$/i, // print timestamps
];

// Devanagari typeset with legacy fonts (Krutidev etc.) extracts as Latin
// mojibake. These are common Hindi words as they appear in that encoding —
// enough hits marks a line as unrecoverable and it's dropped (a readable
// translation column, when present, survives).
const KRUTIDEV_TOKENS = new Set([
  "gS",
  "gSa",
  "dh",
  "ds",
  "dks",
  "ls",
  "esa",
  "vkSj",
  "ugha",
  "rks",
  "Fkk",
  "Fkh",
  "Fks",
  ";g",
  "og",
  "D;k",
  "eSa",
  "ij",
  "Hkh",
  "dj",
  "us",
  "gks",
  "djus",
  "fy,",
  "x;k",
  "x;h",
  "jgk",
  "jgs",
  "jgh",
  "rqe",
  "eq>s",
  "D;ksa",
  "dqN",
  "cgqr",
  "vc",
  "fQj",
  "vki",
  "ge",
]);

function isMojibakeWord(word: string): boolean {
  const bare = word.replace(/[^A-Za-z;+>]/g, "");
  if (KRUTIDEV_TOKENS.has(bare)) return true;
  if (/[A-Za-z][;+][A-Za-z]/.test(word)) return true; // punctuation inside a word
  if (/[¡`È¼½\\[\]<]/.test(word)) return true; // glyphs English never uses
  if (/q(?![uU])[a-z]/.test(word)) return true; // "gq," "iqÙkj" — q without u
  if (/[a-z][A-Z]/.test(word) && !/^(Mc|Mac|O['’])/.test(word)) return true; // "HkkHkh" midword caps
  return false;
}

function looksMojibake(text: string): boolean {
  const words = text.split(/\s+/);
  let hits = 0;
  for (const word of words) if (isMojibakeWord(word)) hits++;
  // Fully garbled short lines, any line with several hits, or mixed
  // bilingual-column rows where garbled tokens make up much of the line.
  return (
    hits >= 2 || (hits >= 1 && words.length <= 4) || hits / words.length >= 0.4
  );
}

/** Rejoin ligature glyphs that extract with a spurious space ("Th e", "fi rst"). */
function fixSplitLigatures(text: string): string {
  return text
    .replace(/\b(Th|Wh)\s(?=[a-z])/g, "$1")
    .replace(/(^|\s)(ffi|ffl|ff|fi|fl)\s(?=[a-z])/g, "$1$2");
}

export type CleanResult = {
  lines: LayoutLineTuple[];
  /** Lines dropped as unreadable original-language text (legacy-font mojibake) */
  droppedMojibake: number;
};

/** Drop junk/mojibake lines and repair extraction artifacts. */
export function cleanLayoutLines(tuples: LayoutLineTuple[]): CleanResult {
  const cleaned: LayoutLineTuple[] = [];
  let droppedMojibake = 0;
  for (const [page, x, rawText] of tuples) {
    const text = String(rawText).trim();
    if (!text) continue;
    if (JUNK_LINES.some((re) => re.test(text))) continue;
    if (looksMojibake(text)) {
      droppedMojibake++;
      continue;
    }
    cleaned.push([page, x, fixSplitLigatures(text)]);
  }
  return { lines: cleaned, droppedMojibake };
}

/** Flatten layout lines to the plain-text form the other strategies consume. */
export function flattenLayout(tuples: LayoutLineTuple[]): string {
  const parts: string[] = [];
  let lastPage: number | null = null;
  for (const [page, , text] of tuples) {
    if (lastPage !== null && page !== lastPage)
      parts.push("\n--- PAGE BREAK ---\n");
    lastPage = page;
    parts.push(String(text));
  }
  return parts.join("\n");
}
