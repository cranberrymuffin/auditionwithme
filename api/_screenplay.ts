// Deterministic screenplay/play segmentation. The heavy lifting (finding speaker
// lines, splitting dialogue into steps) is done here in code so the model never
// has to echo the script text back — that's what makes parsing fast. A small
// model call classifies only what regex can't (see parse-script.ts).

export type StepContent = { kind: "verbal" | "nonverbal"; text: string };
export type ParsedStep = { speaker: string; verbalLine: string; content: StepContent[] };

export const PAGE_BREAK = /^-{2,}\s*PAGE BREAK\s*-{2,}$/;
// "53", "53.", "-11-" — screenplay and play page-number formats
export const PAGE_NUMBER = /^-?\d{1,4}\.?-?$/;
// "(MORE)" / "(CONT'D)" page-wrap markers around speeches
const CONTINUATION_MARKER = /^\(\s*(MORE|CONT'?D|CONTINUED)\s*\)$/i;

// "Author – dialogue" / "Author ( unfriendly ) – dialogue" (European play format;
// en/em dash only, a plain hyphen matches too much prose). Optional parenthetical
// between label and dash is carried into the speech text as a nonverbal cue.
const DASH_SPEAKER = /^([\p{Lu}][\p{L}'’. -]{0,29}?)(\s*\([^)]{0,40}\))?\s*[–—]\s+(\S.*)$/u;
// "AUTHOR: dialogue" (stage play format)
const COLON_SPEAKER = /^([\p{Lu}][\p{L}'’. -]{0,29}?)(\s*\([^)]{0,40}\))?:\s+(\S.*)$/u;
// "AUTHOR", "AUTHOR (V.O.)", or "BOY #1" alone on a line (screenplay format)
const CAPS_SPEAKER = /^([\p{Lu}][\p{Lu}0-9#&'’. -]{1,29}?)(\s*\([^)]{0,24}\))?$/u;
const SCENE_HEADING = /^(INT|EXT|INT\/EXT|I\/E|FADE|CUT|DISSOLVE|SCENE|ACT)\b/i;

const MAX_LABEL_WORDS = 3;

function normalizeLabel(label: string): string {
  return label.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

function isPlausibleLabel(label: string): boolean {
  const words = label.split(/\s+/);
  return label.length > 0 && label.length <= 30 && words.length <= MAX_LABEL_WORDS;
}

/**
 * Scan for candidate speaker labels with occurrence counts. High-frequency
 * candidates are almost certainly characters; the model confirms the set.
 */
export function collectSpeakerCandidates(lines: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (label: string) => counts.set(label, (counts.get(label) ?? 0) + 1);

  for (const line of lines) {
    const dash = DASH_SPEAKER.exec(line);
    if (dash && isPlausibleLabel(normalizeLabel(dash[1]))) {
      bump(normalizeLabel(dash[1]));
      continue;
    }
    const colon = COLON_SPEAKER.exec(line);
    if (colon && isPlausibleLabel(normalizeLabel(colon[1]))) {
      bump(normalizeLabel(colon[1]));
      continue;
    }
    const caps = CAPS_SPEAKER.exec(line);
    if (caps && !SCENE_HEADING.test(line) && isPlausibleLabel(normalizeLabel(caps[1]))) {
      bump(normalizeLabel(caps[1]));
    }
  }

  // Keep labels that recur — one-off matches are usually prose false positives.
  return new Map([...counts.entries()].filter(([, count]) => count >= 2));
}

/** Split a speech into interleaved verbal text and (parenthetical) nonverbal cues. */
export function splitSpeech(text: string): { content: StepContent[]; verbalLine: string } {
  const content: StepContent[] = [];
  const verbalParts: string[] = [];
  const parenthetical = /\(([^)]*)\)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = parenthetical.exec(text))) {
    const before = text.slice(cursor, match.index).trim();
    if (before) {
      content.push({ kind: "verbal", text: before });
      verbalParts.push(before);
    }
    if (match[1].trim()) content.push({ kind: "nonverbal", text: match[0].trim() });
    cursor = match.index + match[0].length;
  }
  const rest = text.slice(cursor).trim();
  if (rest) {
    content.push({ kind: "verbal", text: rest });
    verbalParts.push(rest);
  }
  return { content, verbalLine: verbalParts.join(" ") };
}

export type BuildOptions = {
  /** Confirmed speaker labels → canonical character names */
  labels: Map<string, string>;
  /** Line numbers that are stage directions (not dialogue, not wrapped continuations) */
  stageDirectionLines: Set<number>;
  /** Line numbers that are headers/footers/noise to drop */
  junkLines: Set<number>;
  /** Inclusive line range of the performance text */
  start: number;
  end: number;
};

/**
 * Walk the script and build rehearsal steps: one step per speaker block, with
 * standalone stage directions attached as nonverbal content to the next block.
 */
export function buildSteps(
  lines: string[],
  { labels, stageDirectionLines, junkLines, start, end }: BuildOptions
): { steps: ParsedStep[]; characters: string[] } {
  const steps: ParsedStep[] = [];
  const characters: string[] = [];
  let pendingDirections: string[] = [];
  let currentSpeaker: string | null = null;
  let currentParts: string[] = [];
  let currentLeadIns: string[] = [];

  const matchSpeaker = (line: string): { name: string; text: string } | null => {
    for (const re of [DASH_SPEAKER, COLON_SPEAKER]) {
      const m = re.exec(line);
      if (m) {
        const canonical = labels.get(normalizeLabel(m[1]));
        // A leading parenthetical ("( unfriendly )") joins the speech text and
        // becomes a nonverbal cue when the speech is split.
        if (canonical) return { name: canonical, text: m[2] ? `${m[2].trim()} ${m[3]}` : m[3] };
      }
    }
    const caps = CAPS_SPEAKER.exec(line);
    if (caps) {
      const canonical = labels.get(normalizeLabel(caps[1]));
      if (canonical) return { name: canonical, text: "" };
    }
    return null;
  };

  const flush = () => {
    if (currentSpeaker === null) return;
    const { content, verbalLine } = splitSpeech(currentParts.join(" "));
    const leadIns: StepContent[] = currentLeadIns.map((text) => ({ kind: "nonverbal", text }));
    if (verbalLine || content.length || leadIns.length) {
      steps.push({ speaker: currentSpeaker, verbalLine, content: [...leadIns, ...content] });
      if (!characters.includes(currentSpeaker)) characters.push(currentSpeaker);
    }
    currentSpeaker = null;
    currentParts = [];
    currentLeadIns = [];
  };

  const first = Math.max(0, Math.min(start, lines.length - 1));
  const last = Math.max(first, Math.min(end, lines.length - 1));

  for (let i = first; i <= last; i++) {
    const line = lines[i].trim();
    if (!line || PAGE_BREAK.test(line) || PAGE_NUMBER.test(line) || CONTINUATION_MARKER.test(line) || junkLines.has(i)) continue;

    const speaker = matchSpeaker(line);
    if (speaker) {
      flush();
      currentSpeaker = speaker.name;
      currentParts = speaker.text ? [speaker.text] : [];
      currentLeadIns = pendingDirections;
      pendingDirections = [];
      continue;
    }

    if (stageDirectionLines.has(i) || currentSpeaker === null) {
      // Standalone direction (or prose before the first speaker): ends the
      // current speech and attaches to the next one as setup.
      flush();
      pendingDirections.push(line);
      continue;
    }

    // Wrapped continuation of the current speech.
    currentParts.push(line);
  }

  flush();

  // Trailing directions after the final speech attach to the last step.
  if (pendingDirections.length && steps.length) {
    steps[steps.length - 1].content.push(
      ...pendingDirections.map((text): StepContent => ({ kind: "nonverbal", text }))
    );
  }

  return { steps, characters };
}
