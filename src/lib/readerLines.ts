// Which steps the AI scene partner reads, and the exact TTS request for each.
// Shared by Rehearsal.tsx (playback) and useReaderAudioPregen.ts (generation
// before Start) so both build identical requests — and therefore identical
// cache keys. Pure, so benchmarks/checks/pregen.ts can check it under tsx.
import type { Step } from "../types";
import {
  beatFromContent,
  deliveryTagFromContent,
  isPerformanceMarkup,
  splitLeadingBeat,
  type ReaderBeat,
} from "./delivery";
import { normalizeSpeaker } from "./speaker";
import { clampCharacterEmotion } from "./characterDelivery";
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

// How long the reader holds before an intentional beat, applied client-side
// (Rehearsal.tsx) so the audio itself never starts with silence. Short is a
// breath — a "(beat)" or a reaction before answering; long is a held moment —
// "(a long beat)", "(silence)", a line landing after bad news.
export const SHORT_BEAT_MS = 600;
export const LONG_BEAT_MS = 1500;

const BEAT_MS: Record<ReaderBeat, number> = { short: SHORT_BEAT_MS, long: LONG_BEAT_MS };

/** A reader line as Rehearsal plays it: the TTS request plus the beat (ms of
 * deliberate silence) to hold before playing it. */
export type ReaderCue = { line: TtsLine; beatMs: number };

/**
 * The full synthesis request for a step, and the beat before it: surrounding
 * lines condition the prosody, and an explicit script parenthetical outranks
 * the AI director's inferred direction. Director entries are performance
 * markup of the whole line on newly directed scripts, or a legacy single-word
 * tag on scripts saved before the markup upgrade. A beat — an explicit
 * "(beat)"-style cue before the line, else the director's leading
 * "[short pause]" / "[long pause]" — is split off here so it never reaches
 * the TTS text or the cache key. The speaker's emotion setting goes on the
 * request only when it's off natural, so default reads keep their keys. A
 * line the actor coached (step index → take id in `coachTakes`) is their
 * recording re-voiced instead: just the take and the voice, keeping only the
 * beat before it.
 */
export function buildReaderCue(
  steps: Step[],
  index: number,
  characterVoices: Record<string, string>,
  deliveryTags: (string | null)[],
  characterEmotions: Record<string, number> = {},
  coachTakes: Record<number, string> = {},
): ReaderCue | null {
  const step = steps[index];
  if (!step?.verbalLine.trim()) return null;
  const voiceId = characterVoices[normalizeSpeaker(step.speaker)];
  const before = [...steps.slice(0, index)].reverse().find((item) => item.verbalLine.trim());
  const after = steps.slice(index + 1).find((item) => item.verbalLine.trim());
  const parenthetical = deliveryTagFromContent(step.content);
  const { beat: directedBeat, rest } = splitLeadingBeat(deliveryTags[index] ?? "");
  const directed = parenthetical || !rest ? null : rest;
  // Markup that's only the beat marker plus the line as written reads exactly
  // like the undirected line, so it shares that line's request and key.
  const performance =
    directed && directed !== step.verbalLine && isPerformanceMarkup(directed, step.verbalLine)
      ? directed
      : undefined;
  const legacyTag = directed && directed !== step.verbalLine && !performance ? directed : undefined;
  const beat = beatFromContent(step.content) ?? directedBeat;
  const beatMs = beat ? BEAT_MS[beat] : 0;
  const coachTakeId = coachTakes[index];
  if (coachTakeId) {
    return { line: { text: step.verbalLine, voiceId, coachTakeId }, beatMs };
  }
  const emotion = clampCharacterEmotion(characterEmotions[normalizeSpeaker(step.speaker)]);
  return {
    line: {
      text: step.verbalLine,
      voiceId,
      previousText: before?.verbalLine,
      nextText: after?.verbalLine,
      deliveryTag: parenthetical ?? legacyTag,
      performance,
      ...(emotion ? { emotion } : {}),
    },
    beatMs,
  };
}

/** Just the TTS request — what pre-generation (useReaderAudioPregen.ts)
 * generates and keys; identical to the line Rehearsal plays. */
export function buildReaderLine(
  steps: Step[],
  index: number,
  characterVoices: Record<string, string>,
  deliveryTags: (string | null)[],
  characterEmotions: Record<string, number> = {},
  coachTakes: Record<number, string> = {},
): TtsLine | null {
  return (
    buildReaderCue(steps, index, characterVoices, deliveryTags, characterEmotions, coachTakes)
      ?.line ?? null
  );
}

/** Director tags for the lines in `keepUntagged` stripped back to the read
 * already rendered without them: when the director answers after
 * pre-generation gave up waiting (useReaderAudioPregen.ts), those lines are
 * paid for, and re-rendering them with markup would bill them twice. A
 * leading beat survives — it's client-side timing, not part of the audio or
 * its key. */
export function keepUntaggedReads(
  steps: Step[],
  deliveryTags: (string | null)[],
  keepUntagged: Iterable<number>,
): (string | null)[] {
  const tags = [...deliveryTags];
  for (const index of keepUntagged) {
    const step = steps[index];
    if (!step || index >= tags.length) continue;
    const { beat } = splitLeadingBeat(tags[index] ?? "");
    tags[index] = beat ? `[${beat} pause] ${step.verbalLine}` : null;
  }
  return tags;
}
