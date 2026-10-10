import { apiFetch } from "./api";
import type { ContentLine, Step } from "../types";
import { normalizeSpeaker } from "./speaker";

export type Voice = {
  id: string;
  name: string;
  gender: string;
  age: string;
  accent: string;
  description: string;
  language: string;
  locale: string;
  tone: string;
};

export function describeVoice(v: Voice): string {
  return [v.accent, v.gender, v.age, v.tone].filter(Boolean).map(humanizeVoiceLabel).join(" · ");
}

export function voiceDisplayName(name: string): string {
  return name.split(/\s+-\s+/)[0].trim();
}

export function humanizeVoiceLabel(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** Title-cases an ALL-CAPS script character name for display, e.g. "MARY" -> "Mary". */
export function displayCharacterName(name: string): string {
  return name.toLocaleLowerCase().replace(/(^|[\s'-])\p{L}/gu, (letter) => letter.toLocaleUpperCase());
}

export { normalizeSpeaker } from "./speaker";

/** The steps a character speaks a line in, in script order. */
export function spokenLines(steps: Step[], speaker: string): Step[] {
  return steps.filter((step) => normalizeSpeaker(step.speaker) === speaker && step.verbalLine.trim());
}

// A screenplay scene heading ("INT. CAR - DAY", "3 EXT. BEACH - NIGHT 3").
// Upper case only, so prose that happens to start "Int..." never matches.
const SCENE_HEADING = /^(?:\d+[A-Z]?\s+)?(?:INT|EXT|INT\.?\s*\/\s*EXT|EXT\.?\s*\/\s*INT|I\/E)[.\s]/;

export function isSceneHeading(text: string): boolean {
  return SCENE_HEADING.test(text.trim());
}

/** A scene heading without its margin scene numbers. */
export function cleanSceneHeading(text: string): string {
  return text.trim().replace(/^\d+[A-Z]?\s+/, "").replace(/\s+\d+[A-Z]?$/, "");
}

/**
 * A step's content split the way a script page lays it out: the scene
 * heading it opens (if any), the stage directions before anyone speaks, and
 * the speech itself (with any mid-speech directions left in place).
 */
export function splitStepContent(step: Step): {
  sceneHeading: string | null;
  leadIn: string[];
  speech: ContentLine[];
} {
  let sceneHeading: string | null = null;
  const leadIn: string[] = [];
  let i = 0;
  for (; i < step.content.length; i++) {
    const item = step.content[i];
    if (item.kind !== "nonverbal") break;
    if (isSceneHeading(item.text)) {
      // A later heading in the same run starts the scene this line is in.
      sceneHeading = cleanSceneHeading(item.text);
      leadIn.length = 0;
    } else {
      leadIn.push(item.text);
    }
  }
  // A step that's nothing but directions keeps them as its body.
  if (i === step.content.length && !step.verbalLine.trim()) {
    return { sceneHeading, leadIn: [], speech: leadIn.map((text) => ({ kind: "nonverbal", text })) };
  }
  return { sceneHeading, leadIn, speech: step.content.slice(i) };
}

/** "1 dialogue turn", "16 dialogue turns". */
export function dialogueTurnsLabel(count: number): string {
  return `${count} ${count === 1 ? "dialogue turn" : "dialogue turns"}`;
}

/**
 * Fallback for a line that stalled short of a full countMatchedWords match
 * even after the actor paused (nothing left to transcribe for this attempt):
 * asks the server whether the transcript it did get still conveys the
 * line's meaning, tolerating mishears/garbling that exact/fuzzy word
 * matching couldn't get past. Returns false (never advance) on any request
 * failure rather than surfacing an error into the rehearsal flow.
 */
export async function checkSemanticLineMatch(line: string, transcript: string): Promise<boolean> {
  try {
    const response = await apiFetch("/api/casting?action=semantic-match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ line, transcript }),
    });
    if (!response.ok) return false;
    const data = (await response.json()) as { match?: boolean };
    return data.match === true;
  } catch {
    return false;
  }
}
