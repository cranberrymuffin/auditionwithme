// Blind A/B listening harness for the scene partner's tone (beta feedback:
// "the reader is over the top"). Renders each line in
// test_data/tts-tone-lines.json twice through the real pipeline pieces:
//
//   old — the original "skilled actor" director prompt + v3 Creative (0)
//         stability on every line (what intensity "dramatic" produced)
//   new — the current reader-first DIRECTOR_PROMPT (api/casting.ts) +
//         v3Stability() (api/tts.ts): 0.3, Creative only for
//         BIG_DELIVERY_TAGS script parentheticals
//
// Each pair is written to benchmarks/out/tts-tone/ as <id>-A.mp3 and
// <id>-B.mp3 with old/new randomly assigned per line, so you can listen
// without knowing which is which. key.json holds the answer plus the markup
// each prompt produced; open it only after you've picked a favorite per line.
//
// COSTS MONEY: one Anthropic call per line per prompt and one ElevenLabs v3
// render per line per variant (12 renders). Needs ANTHROPIC_API_KEY and
// ELEVENLABS_API_KEY in the environment.
//
//   npx tsx benchmarks/tts-tone.ts             # render to benchmarks/out/
//   npx tsx benchmarks/tts-tone.ts --dry-run   # print the plan, no API calls
//
// Run with tsx (node's type stripping doesn't map the ".js" ESM specifiers
// the api/ modules use).

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "test_data", "tts-tone-lines.json");
const OUT_DIR = join(ROOT, "benchmarks", "out", "tts-tone");
const DRY_RUN = process.argv.includes("--dry-run");

// Same model/settings api/casting.ts's directLines uses, so the markup
// matches what a real script would get.
const DIRECTOR_MODEL = "claude-opus-5";
const TTS_MODEL = "eleven_v3";
const DEFAULT_VOICE_ID = "pFZP5JQG7iQjIQuC4Bku";

// Frozen copy of the director prompt as it stood before the reader-first
// rewrite — the "old" side of the comparison. Don't update this.
const OLD_TAG_VOCABULARY = [
  "angry", "annoyed", "cold", "sad", "somber", "crying", "cheerful", "warm",
  "excited", "playful", "teasing", "flirtatious", "nervous", "hesitant",
  "scared", "terrified", "surprised", "shocked", "confused", "curious",
  "sarcastic", "deadpan", "mocking", "threatening", "pleading", "desperate",
  "tired", "resigned", "whispers", "shouts", "laughs", "sighs",
];

const OLD_DIRECTOR_PROMPT = `You are a voice director preparing an AI scene partner (ElevenLabs Eleven v3) to read lines opposite a human actor. For each numbered dialogue line, decide how a skilled actor would deliver it given the surrounding scene, and return a performance markup of that exact line.

Your markup toolkit (Eleven v3):
- Audio tags in square brackets, placed at the start of the line or between sentences — emotional tags (${OLD_TAG_VOCABULARY.join(", ")}) and non-verbal sounds ([laughs], [chuckles], [sighs], [gasps], [pause], [clears throat]).
- Pacing punctuation: ellipses (…) for weighted pauses and trailing thoughts, em-dashes for interruptions and pivots.
- Emphasis: CAPITALIZE a single stressed word where a real actor would punch it.

Rules:
- NEVER add, remove, reorder, or respell words. Only bracketed tags, punctuation, and letter casing may differ from the input line. Entries that change the words are discarded.
- At most 2 audio tags per line. Don't front-load every line with an emotion tag — most conversational lines need only pacing punctuation, or nothing. Save emotional tags for lines where the scene clearly calls for them, and vary them; a scene where every line is tagged reads as melodrama.
- Judge from context, not just the line itself — a line's delivery depends on what was said before and where the scene is going.
- Return null for lines that are fine exactly as written.
- Return ONLY a JSON array, no prose and no markdown fences, with exactly one entry (a markup string or null) per input line, in input order.

Example output: [null, "[nervous] You're supposed to say what you're… thankful for.", null, "I KNOW what I said — [sighs] just forget it."]`;

// The old pipeline always ran at intensity "dramatic", which mapped every
// line to v3 Creative regardless of tags.
const OLD_STABILITY = 0;

type DialogueLine = { speaker: string; text: string };

type ToneLine = DialogueLine & {
  id: string;
  variant: string;
  /** Script parenthetical, already mapped to a v3 tag — skips the director. */
  deliveryTag?: string;
  context?: DialogueLine[];
};

type Fixture = { voices?: Record<string, string>; lines: ToneLine[] };

type Render = { markup: string | null; text: string; stability: number };

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set.`);
    process.exit(1);
  }
  return value;
}

function extractJsonArray(raw: string): unknown[] | null {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end < start) return null;
  try {
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function main() {
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;

  if (DRY_RUN) {
    // The api/ modules construct an Anthropic client at import time, which
    // throws without a key — a placeholder is enough to inspect the plan.
    process.env.ANTHROPIC_API_KEY ??= "dry-run";
  } else {
    requireEnv("ANTHROPIC_API_KEY");
  }
  const elevenKey = DRY_RUN ? "" : requireEnv("ELEVENLABS_API_KEY");

  // Imported after the env check above (see dry-run note).
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const { DIRECTOR_PROMPT } = await import("../api/casting.js");
  const { BIG_DELIVERY_TAGS, v3Stability } = await import("../api/tts.js");
  const { sanitizePerformance } = await import("../api/_direction.js");

  // The stability contract the tone fix depends on (runs in --dry-run too).
  assert.equal(v3Stability(false), 0.3, "untagged/director lines read at 0.3");
  assert.equal(v3Stability(true), 0, "big-delivery parentheticals read at Creative");

  const anthropic = new Anthropic();

  // Mirrors directLines: the scene is numbered one line per row and the
  // director returns one markup entry per row. Only the target (last) row's
  // markup is used; the context rows are there so it judges from the scene.
  async function direct(prompt: string, line: ToneLine): Promise<string | null> {
    const rows = [...(line.context ?? []), line];
    const numbered = rows
      .map((row, index) => `${index}| ${row.speaker}: ${row.text}`)
      .join("\n");
    if (DRY_RUN) return null;
    const response = await anthropic.messages.create({
      model: DIRECTOR_MODEL,
      max_tokens: 4000,
      output_config: { effort: "low" },
      system: prompt,
      messages: [
        { role: "user", content: `Scene dialogue, one line per row:\n${numbered}` },
      ],
    });
    const textBlock = response.content.find((block) => block.type === "text");
    const entries = extractJsonArray(textBlock?.type === "text" ? textBlock.text : "");
    return sanitizePerformance(entries?.[rows.length - 1], line.text);
  }

  // Same text shaping as api/tts.ts: an explicit parenthetical tag outranks
  // director markup; otherwise the markup (if valid) is read as written.
  function shape(line: ToneLine, markup: string | null): string {
    if (line.deliveryTag) return `[${line.deliveryTag}] ${line.text}`;
    return markup ?? line.text;
  }

  async function render(text: string, stability: number, voiceId: string, file: string) {
    if (DRY_RUN) return;
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
      {
        method: "POST",
        headers: { "xi-api-key": elevenKey, "Content-Type": "application/json" },
        body: JSON.stringify({ text, model_id: TTS_MODEL, voice_settings: { stability } }),
      },
    );
    if (!response.ok) {
      throw new Error(`ElevenLabs ${response.status}: ${await response.text()}`);
    }
    writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  }

  if (!DRY_RUN) mkdirSync(OUT_DIR, { recursive: true });
  const key: Record<string, { A: "old" | "new"; B: "old" | "new"; old: Render; new: Render }> = {};

  // Sequential on purpose: the ElevenLabs account's concurrency is shared
  // with every live rehearsal (api/tts.ts uses the same key).
  for (const line of fixture.lines) {
    const voiceId = fixture.voices?.[line.speaker] ?? DEFAULT_VOICE_ID;
    const [oldMarkup, newMarkup] = line.deliveryTag
      ? [null, null]
      : await Promise.all([direct(OLD_DIRECTOR_PROMPT, line), direct(DIRECTOR_PROMPT, line)]);

    const variants = {
      old: { markup: oldMarkup, text: shape(line, oldMarkup), stability: OLD_STABILITY },
      new: {
        markup: newMarkup,
        text: shape(line, newMarkup),
        stability: v3Stability(line.deliveryTag != null && BIG_DELIVERY_TAGS.has(line.deliveryTag)),
      },
    } satisfies Record<"old" | "new", Render>;

    const oldIsA = Math.random() < 0.5;
    const order = oldIsA ? (["old", "new"] as const) : (["new", "old"] as const);
    for (const [slot, which] of [["A", order[0]], ["B", order[1]]] as const) {
      const variant = variants[which];
      await render(variant.text, variant.stability, voiceId, join(OUT_DIR, `${line.id}-${slot}.mp3`));
    }
    key[line.id] = { A: order[0], B: order[1], ...variants };

    console.log(
      DRY_RUN
        ? `${line.id} [${line.variant}] old stability=${variants.old.stability}, new stability=${variants.new.stability}${line.deliveryTag ? `, tag=[${line.deliveryTag}]` : ", director markup on both"}`
        : `${line.id} [${line.variant}] rendered A/B`,
    );
  }

  if (DRY_RUN) {
    console.log("\nDry run: no API calls made, nothing written.");
    return;
  }
  writeFileSync(join(OUT_DIR, "key.json"), JSON.stringify(key, null, 2) + "\n");
  console.log(`\nWrote ${fixture.lines.length * 2} renders to ${OUT_DIR}`);
  console.log("Listen to each A/B pair blind, note which sounds less over the top, then check key.json.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
