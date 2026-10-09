import { apiFetch } from "./api";

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
