// Which steps the AI scene partner reads, and the exact TTS request for each.
// Shared by Rehearsal.tsx (playback) and useReaderAudioPregen.ts (generation
// before Start) so both build identical requests — and therefore identical
// cache keys. Pure, so benchmarks/pregen.ts can check it under tsx.
import type { Step } from "../types";
import { deliveryTagFromContent, isPerformanceMarkup } from "./delivery";
import { normalizeSpeaker } from "./speaker";
import type { TtsLine } from "./ttsCacheKey";

/** Indices of the steps the reader voices: every spoken line not belonging
 * to the actor's role (all of them when just listening, role ""). */
export function readerLineIndices(steps: Step[], selectedRole: string): number[] {
  const indices: number[] = [];
  steps.forEach((step, index) => {
    if (!step.verbalLine.trim()) return;
    if (selectedRole && normalizeSpeaker(step.speaker) === selectedRole) return;
    indices.push(index);
  });
  return indices;
}

/**
 * The full synthesis request for a step: surrounding lines condition the
 * prosody, and an explicit script parenthetical outranks the AI director's
 * inferred direction. Director entries are performance markup of the whole
 * line on newly directed scripts, or a legacy single-word tag on scripts
 * saved before the markup upgrade.
 */
export function buildReaderLine(
  steps: Step[],
  index: number,
  characterVoices: Record<string, string>,
  deliveryTags: (string | null)[],
): TtsLine | null {
  const step = steps[index];
  if (!step?.verbalLine.trim()) return null;
  const before = [...steps.slice(0, index)].reverse().find((item) => item.verbalLine.trim());
  const after = steps.slice(index + 1).find((item) => item.verbalLine.trim());
  const parenthetical = deliveryTagFromContent(step.content);
  const directed = parenthetical ? null : deliveryTags[index];
  const performance = directed && isPerformanceMarkup(directed, step.verbalLine) ? directed : undefined;
  return {
    text: step.verbalLine,
    voiceId: characterVoices[normalizeSpeaker(step.speaker)],
    previousText: before?.verbalLine,
    nextText: after?.verbalLine,
    deliveryTag: parenthetical ?? (performance ? undefined : directed ?? undefined),
    performance,
    // Every line built here is read by the AI scene partner, never the
    // actor's own voice — a beat of silence up front keeps the read from
    // cutting in over trailing words as the actor finishes their line.
    leadingPause: true,
  };
}
