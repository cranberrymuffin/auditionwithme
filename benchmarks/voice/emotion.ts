// Emotiveness benchmark for the scene partner's voice (beta feedback: "the
// reader sounds robotic"). Renders the labelled lines in
// test_data/tts-emotion-lines.json under one or more configurations
// (benchmarks/voice/emotion-configs.ts) through the real pipeline pieces —
// the AI director prompt, sanitizePerformance, the stability rules — and
// produces everything the three measurement tiers need:
//
//   1. audit.json      how the director shaped each line vs. its label
//                      (no audio needed: --direct-only)
//   2. acoustics       run benchmarks/voice/acoustics.py on the output folder
//   3. rater.html      blind A/B pairs of every config against --pair-with;
//                      raters download a ratings JSON, scored with --score
//
// Output: benchmarks/out/tts-emotion/<run>/
//   <line>--<config>.mp3   per-line renders (scene clips for dialogue mode)
//   key.json               every render with its markup, settings and voice
//   audit.json             per-line and per-config markup audit
//   pairs.json, rater.html the blind listening test
//
// COSTS MONEY once past --dry-run: one Anthropic call per scene per prompt
// variant, one ElevenLabs render per line per config. Needs ANTHROPIC_API_KEY
// and ELEVENLABS_API_KEY. Renders run one at a time on purpose: the
// ElevenLabs account's concurrency is shared with live rehearsals.
//
//   npm run bench:emotion -- --dry-run --quick               # plan + checks, no calls
//   npm run bench:emotion -- --direct-only --config warm-prompt   # director + audit only
//   npm run bench:emotion -- --quick --config v4 --run v4-quick
//   npm run bench:emotion -- --config v4 --config stab-0.45 --run week1
//   npm run bench:emotion -- --score ratings-*.json --run week1
//   npm run bench:emotion -- --ai-rate --run week1            # Gemini listens (GEMINI_API_KEY)
//   npm run bench:emotion -- --agreement ratings-jess.json ratings-ai-gemini-2.5-flash.json --run week1
//   npm run bench:emotion -- --list
//
// The AI rater (--ai-rate) answers the same three questions as the human
// page from the audio itself, through an audio-capable model (Gemini by
// default; Claude can't take audio). It hears every pair in both orders and
// only counts an answer the two orders agree on, which removes the judge's
// position bias. Treat it as a way to scale ratings across hundreds of
// pairs, not a replacement for ears: --agreement reports how often it
// agrees with a human file, and it's only worth trusting on a run where
// that agreement is good.
//
// Run with tsx (node's type stripping doesn't map the ".js" ESM specifiers
// the api/ modules use).

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIGS, DEFAULT_PAIR_WITH, WARM_DIRECTOR_PROMPT, type TtsConfig } from "./emotion-configs.js";
import {
  auditLine,
  extractTags,
  pacingShaped,
  summarizeAudit,
  tagFamily,
  wilson,
  type Label,
  type LineAudit,
} from "./emotion-audit.js";
import {
  beatFromContent,
  deliveryTagFromContent,
  splitLeadingBeat,
} from "../../src/lib/delivery.js";
import type { ContentLine } from "../../src/types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE = join(ROOT, "test_data", "tts-emotion-lines.json");
const OUT_ROOT = join(ROOT, "benchmarks", "out", "tts-emotion");

const DIRECTOR_MODEL = "claude-opus-5";
const DEFAULT_VOICE_ID = "pFZP5JQG7iQjIQuC4Bku"; // Lily, api/tts.ts's fallback
// api/tts.ts's EMOTION_STABILITY_SPAN and CONTEXT_CHAR_LIMIT.
const EMOTION_STABILITY_SPAN = 0.3;
const CONTEXT_CHAR_LIMIT = 1800;
// api/casting.ts's MAX_DIRECTION_CHARS.
const MAX_DIRECTION_CHARS = 200;
// Text-to-Dialogue's documented per-request ceiling.
const DIALOGUE_CHAR_LIMIT = 2000;

type SceneLine = { speaker: string; text: string; direction?: string };
type Scene = { id: string; source: string; heading: string; lines: SceneLine[] };
type Target = { id: string; scene: string; index: number; quick?: boolean; label: Label };
type Fixture = { voices: Record<string, string>; scenes: Scene[]; targets: Target[] };

type Render = {
  line: string;
  config: string;
  file: string;
  /** Scene clip (dialogue mode) rather than one line. */
  scene?: string;
  speaker: string;
  voice: string;
  voiceId: string;
  model: string;
  text: string;
  markup: string | null;
  deliveryTag: string | null;
  beat: string | null;
  stability: number;
  /** Characters ElevenLabs billed for the render, from its character-cost header. */
  cost?: number;
  /** The render failed (status and message); no file was written. */
  error?: string;
};

type Pair = {
  id: string;
  line: string;
  speaker: string;
  text: string;
  context: string[];
  A: string;
  B: string;
};

// ---------------------------------------------------------------- CLI

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const values = (name: string) =>
  argv.flatMap((arg, i) => (arg === `--${name}` && argv[i + 1] ? [argv[i + 1]] : []));
const value = (name: string) => values(name)[0];

const DRY_RUN = flag("dry-run");
const AI_MODEL = value("ai-model") ?? "gemini-2.5-flash";
const DIRECT_ONLY = flag("direct-only");
const QUICK = flag("quick");
const PAIR_WITH = value("pair-with") ?? DEFAULT_PAIR_WITH;

// ---------------------------------------------------------------- helpers

/** A fixture direction as production's step content: each parenthetical its
 * own item, so "(panicked)" maps to a delivery tag and "(beat)" to a beat
 * exactly as src/lib/delivery.ts does on a parsed script. */
export function toContent(direction: string | undefined): ContentLine[] {
  if (!direction) return [];
  return direction
    .split(/(\([^)]*\))/)
    .map((piece) => piece.trim())
    .filter(Boolean)
    .map((text) => ({ kind: "nonverbal" as const, text }));
}

/** The {stage: …} the director sees for a row — api/casting.ts's clipping. */
function stageFor(line: SceneLine): string {
  return (line.direction ?? "")
    .replace(/[{}[\]<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DIRECTION_CHARS);
}

function numberedRows(scene: Scene): string {
  return scene.lines
    .map((line, index) => {
      const stage = stageFor(line);
      return `${index}| ${stage ? `{stage: ${stage}} ` : ""}${line.speaker}: ${line.text}`;
    })
    .join("\n");
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

const clampStability = (stability: number) => Math.round(Math.min(Math.max(stability, 0), 1) * 100) / 100;

/** api/tts.ts's v3Stability, with the config's base instead of 0.3. */
export function stabilityFor(config: TtsConfig, bigDelivery: boolean): number {
  return bigDelivery ? 0 : clampStability(config.stability - config.emotion * EMOTION_STABILITY_SPAN);
}

/** api/tts.ts's text shaping: a script parenthetical outranks director
 * markup; markup that's only the beat marker plus the line reads as the
 * bare line. */
export function shapeLine(
  text: string,
  deliveryTag: string | undefined,
  directed: string | null,
): { text: string; markup: string | null; beat: string | null } {
  const { beat, rest } = splitLeadingBeat(directed ?? "");
  if (deliveryTag) return { text: `[${deliveryTag}] ${text}`, markup: null, beat: beat ?? null };
  const markup = rest && rest !== text ? rest : null;
  return { text: markup ?? text, markup, beat: beat ?? null };
}

function requireEnv(name: string): string {
  const found = process.env[name];
  if (!found) {
    console.error(`${name} is not set.`);
    process.exit(1);
  }
  return found;
}

function pct(share: number | null): string {
  return share === null ? "   —" : `${Math.round(share * 100)}%`.padStart(4);
}

// ---------------------------------------------------------------- checks

function runChecks() {
  // Fixture directions become production-shaped content.
  const content = toContent("Lolly stops short. Her eyes go wide with fear. (suddenly sober)");
  assert.equal(content.length, 2);
  assert.equal(deliveryTagFromContent(toContent("(panicked)")), "panicked");
  assert.equal(deliveryTagFromContent(toContent("(laughing)")), "laughs");
  assert.equal(deliveryTagFromContent(toContent("(makes a buzzer sound)")), undefined);
  assert.equal(beatFromContent(toContent("(beat)")), "short");
  assert.equal(deliveryTagFromContent(toContent("Robby’s clock turns: 7:23AM. He grunts and flails his arms.")), undefined);

  // Stability follows api/tts.ts's rules around the config's base.
  const base = CONFIGS.baseline;
  assert.equal(stabilityFor(base, false), 0.3);
  assert.equal(stabilityFor(base, true), 0);
  assert.equal(stabilityFor(CONFIGS["emotion-0.5"], false), 0.15);
  assert.equal(stabilityFor(CONFIGS["stab-0.5"], false), 0.5);

  // Text shaping matches production.
  assert.deepEqual(shapeLine("Please.", "pleading", "[sad] Please."), { text: "[pleading] Please.", markup: null, beat: null });
  assert.deepEqual(shapeLine("So I’m Nancy?!", undefined, "[short pause] So I’m Nancy?!"), { text: "So I’m Nancy?!", markup: null, beat: "short" });
  assert.deepEqual(shapeLine("Not now.", undefined, "[cold] Not now."), { text: "[cold] Not now.", markup: "[cold] Not now.", beat: null });

  // Audit scoring.
  assert.deepEqual(extractTags("[long pause] [hurt] You're… [sighs] fine."), ["hurt", "sighs"]);
  assert.equal(tagFamily("low tired voice"), "tired");
  assert.equal(tagFamily("sophisticated"), "sarcastic");
  assert.equal(tagFamily("zzz"), null);
  assert.equal(pacingShaped("I waited… all night.", "I waited all night."), true);
  const label: Label = { emotion: "x", family: "sad", intensity: "low", cue: "dialogue", reply: true };
  const sadAudit = auditLine("a", label, "[tired] Yeah.", "Yeah.");
  assert.equal(sadAudit.familyMatch, true, "a neighbouring family counts");
  assert.equal(auditLine("b", label, "[cheerful] Yeah.", "Yeah.").familyMatch, false);
  assert.equal(auditLine("c", label, null, "Yeah.").familyMatch, null);
  assert.equal(auditLine("c", label, null, "Yeah.").shaped, false);
  const summary = summarizeAudit([
    sadAudit,
    auditLine("d", { ...label, family: "neutral" }, "[angry] Fine.", "Fine."),
    auditLine("e", label, null, "Okay."),
  ]);
  assert.equal(summary.cuedButFlat, 0.5);
  assert.equal(summary.neutralOverTagged, 1);
  assert.equal(summary.familyMatchRate, 1);
  const interval = wilson(13, 20);
  assert.ok(interval.low > 0.4 && interval.high < 0.85);

  // Every fixture target points at a real line, ids are unique, families valid.
  const fixture = loadFixture();
  const ids = new Set<string>();
  const families = new Set(["neutral", "warm", "sad", "angry", "anxious", "playful", "sarcastic", "pleading", "commanding", "surprised", "tired", "menacing"]);
  for (const target of fixture.targets) {
    assert.ok(!ids.has(target.id), `duplicate target id ${target.id}`);
    ids.add(target.id);
    const scene = fixture.scenes.find((candidate) => candidate.id === target.scene);
    assert.ok(scene, `${target.id}: unknown scene ${target.scene}`);
    assert.ok(scene.lines[target.index], `${target.id}: no line ${target.index} in ${target.scene}`);
    assert.ok(families.has(target.label.family), `${target.id}: bad family ${target.label.family}`);
    assert.ok(fixture.voices[scene.lines[target.index].speaker], `${target.id}: no voice for ${scene.lines[target.index].speaker}`);
  }
  for (const [name, config] of Object.entries(CONFIGS)) {
    assert.equal(config.name, name, `config ${name} is misnamed`);
  }
  console.log("checks passed");
}

function loadFixture(): Fixture {
  return JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;
}

// ---------------------------------------------------------------- scoring

type Rating = { natural?: "A" | "B" | "tie"; fit?: "A" | "B" | "tie"; tooMuch?: "A" | "B" | "neither" | "both" };
type Ratings = { rater?: string; pairs?: Record<string, Rating> };
type PairKey = Record<string, { A: string; B: string }>;

function score(run: string, files: string[]) {
  const dir = join(OUT_ROOT, run);
  const pairs = JSON.parse(readFileSync(join(dir, "pairs.json"), "utf8")) as Pair[];
  const key = JSON.parse(readFileSync(join(dir, "pair-key.json"), "utf8")) as PairKey;
  const byId = new Map(pairs.map((pair) => [pair.id, pair]));

  type Tally = { natural: [number, number, number]; fit: [number, number, number]; tooMuch: [number, number]; n: number };
  const tallies = new Map<string, Tally>();
  const tally = (config: string) => {
    const existing = tallies.get(config);
    if (existing) return existing;
    const fresh: Tally = { natural: [0, 0, 0], fit: [0, 0, 0], tooMuch: [0, 0], n: 0 };
    tallies.set(config, fresh);
    return fresh;
  };

  let raters = 0;
  for (const file of files) {
    const ratings = JSON.parse(readFileSync(file, "utf8")) as Ratings;
    raters += 1;
    for (const [pairId, rating] of Object.entries(ratings.pairs ?? {})) {
      const pair = byId.get(pairId);
      const slots = key[pairId];
      if (!pair || !slots) continue;
      // The config under test is whichever side isn't the reference.
      const testSlot = slots.A === PAIR_WITH ? "B" : "A";
      const config = slots[testSlot];
      const t = tally(config);
      t.n += 1;
      const bucket = (choice: "A" | "B" | "tie" | undefined): 0 | 1 | 2 | null =>
        choice === undefined ? null : choice === "tie" ? 2 : choice === testSlot ? 0 : 1;
      const natural = bucket(rating.natural);
      if (natural !== null) t.natural[natural] += 1;
      const fit = bucket(rating.fit);
      if (fit !== null) t.fit[fit] += 1;
      if (rating.tooMuch === testSlot || rating.tooMuch === "both") t.tooMuch[0] += 1;
      if (rating.tooMuch === (testSlot === "A" ? "B" : "A") || rating.tooMuch === "both") t.tooMuch[1] += 1;
    }
  }

  console.log(`\n${raters} rater file(s), reference = ${PAIR_WITH}\n`);
  console.log(`${"config".padEnd(14)} ${"n".padStart(4)}  ${"natural win".padStart(22)}  ${"fit win".padStart(22)}  ${"ties".padStart(10)}  ${"too much (test/ref)".padStart(20)}`);
  for (const [config, t] of [...tallies.entries()].sort()) {
    const nat = wilson(t.natural[0], t.natural[0] + t.natural[1]);
    const fit = wilson(t.fit[0], t.fit[0] + t.fit[1]);
    const fmt = (interval: { p: number; low: number; high: number }) =>
      `${pct(interval.p)} [${pct(interval.low).trim()}–${pct(interval.high).trim()}]`.padStart(22);
    console.log(
      `${config.padEnd(14)} ${String(t.n).padStart(4)}  ${fmt(nat)}  ${fmt(fit)}  ${`${pct(t.n ? t.natural[2] / t.n : 0)}/${pct(t.n ? t.fit[2] / t.n : 0)}`.padStart(10)}  ${`${pct(t.n ? t.tooMuch[0] / t.n : 0)} / ${pct(t.n ? t.tooMuch[1] / t.n : 0)}`.padStart(20)}`,
    );
  }
  console.log("\nWin rates exclude ties; brackets are 95% Wilson intervals. Ship criteria: natural ≥ 65% with the interval's low end above 50%, fit not worse, too much not above the reference.");
}

// ---------------------------------------------------------------- AI rater

type Verdict = { natural: "A" | "B" | "tie"; fit: "A" | "B" | "tie"; tooMuch: "A" | "B" | "both" | "neither"; reason: string };

const AI_RUBRIC = `You are an experienced audition coach judging an AI scene partner that reads opposite a human actor. You will hear the same line of dialogue read twice, read A then read B, by the same voice. The scene partner should sound like a real, present reader: emotionally truthful to the moment, specific, never flat or mechanical, and never over the top (it supports the actor, it doesn't perform at them).

Answer with JSON only:
- "natural": which read sounds more like a real person speaking in this moment ("A", "B", or "tie").
- "fit": which read fits the emotional moment of the scene better ("A", "B", or "tie").
- "tooMuch": which read, if any, is over-acted or melodramatic for an audition reader ("A", "B", "both", or "neither").
- "reason": one sentence.
Judge the delivery only — the words are identical.`;

const swapVerdict = (verdict: Verdict): Verdict => {
  const flip = <T extends string>(choice: T): T =>
    (choice === "A" ? "B" : choice === "B" ? "A" : choice) as T;
  return { ...verdict, natural: flip(verdict.natural), fit: flip(verdict.fit), tooMuch: flip(verdict.tooMuch) };
};

async function geminiJudge(apiKey: string, prompt: string, first: Buffer, second: Buffer): Promise<Verdict> {
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          { text: "Read A:" },
          { inline_data: { mime_type: "audio/mpeg", data: first.toString("base64") } },
          { text: "Read B:" },
          { inline_data: { mime_type: "audio/mpeg", data: second.toString("base64") } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          natural: { type: "STRING", enum: ["A", "B", "tie"] },
          fit: { type: "STRING", enum: ["A", "B", "tie"] },
          tooMuch: { type: "STRING", enum: ["A", "B", "both", "neither"] },
          reason: { type: "STRING" },
        },
        required: ["natural", "fit", "tooMuch", "reason"],
      },
    },
  };
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(AI_MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    );
    if ((response.status === 429 || response.status >= 500) && attempt < 4) {
      const wait = 4000 * (attempt + 1);
      console.warn(`${response.status} from Gemini; waiting ${wait}ms`);
      await new Promise((resolve) => setTimeout(resolve, wait));
      continue;
    }
    if (!response.ok) throw new Error(`Gemini ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const data = (await response.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
    return JSON.parse(text) as Verdict;
  }
}

async function aiRate(run: string, limit: number | null) {
  const dir = join(OUT_ROOT, run);
  // The same --quick / --lines / --config filters as rendering, so a slice of a
  // big run can be rated first.
  const quickIds = new Set(loadFixture().targets.filter((target) => target.quick).map((target) => target.id));
  const onlyLines = new Set(values("lines").flatMap((list) => list.split(",")));
  const onlyConfigs = new Set(values("config"));
  const pairs = (JSON.parse(readFileSync(join(dir, "pairs.json"), "utf8")) as Pair[])
    .filter((pair) => !QUICK || quickIds.has(pair.line))
    .filter((pair) => !onlyLines.size || onlyLines.has(pair.line))
    .filter((pair) => !onlyConfigs.size || onlyConfigs.has(pair.id.slice(pair.line.length + 2)))
    .slice(0, limit ?? undefined);
  console.log(`AI rater: ${pairs.length} pairs × 2 orders through ${AI_MODEL}`);
  if (DRY_RUN) {
    console.log("Dry run: no calls made.");
    return;
  }
  const apiKey = requireEnv("GEMINI_API_KEY");
  const out = join(dir, `ratings-ai-${AI_MODEL.replace(/[^a-z0-9.]+/gi, "-")}.json`);
  const existing = existsSync(out)
    ? (JSON.parse(readFileSync(out, "utf8")) as { pairs: Record<string, Rating & { reasons?: string[]; agreed?: boolean }> })
    : { pairs: {} };
  const ratings = existing.pairs;
  let done = 0;
  for (const pair of pairs) {
    if (ratings[pair.id]) continue;
    const prompt = `${AI_RUBRIC}\n\nScene context:\n${pair.context.join("\n") || "(scene opens)"}\n\nThe line, read by ${pair.speaker}: "${pair.text}"`;
    const a = readFileSync(join(dir, pair.A));
    const b = readFileSync(join(dir, pair.B));
    try {
      const forward = await geminiJudge(apiKey, prompt, a, b);
      const backward = swapVerdict(await geminiJudge(apiKey, prompt, b, a));
      const agree = <K extends keyof Verdict>(key: K, tie: Verdict[K]): Verdict[K] =>
        forward[key] === backward[key] ? forward[key] : tie;
      ratings[pair.id] = {
        natural: agree("natural", "tie"),
        fit: agree("fit", "tie"),
        tooMuch: agree("tooMuch", "neither"),
        reasons: [forward.reason, backward.reason],
        agreed: forward.natural === backward.natural && forward.fit === backward.fit,
      };
    } catch (error) {
      console.warn(`${pair.id}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    done += 1;
    writeFileSync(out, JSON.stringify({ run, rater: `ai:${AI_MODEL}`, pairs: ratings }, null, 2) + "\n");
    if (done % 10 === 0) console.log(`${done} pairs rated`);
  }
  const agreed = Object.values(ratings).filter((rating) => rating.agreed).length;
  console.log(`Wrote ${out}: ${Object.keys(ratings).length} pairs, order-consistent on ${agreed}.`);
  console.log(`Score with: npm run bench:emotion -- --score ${out} --run ${run}`);
}

/** How often two rating files agree on the pairs they share: percent
 * agreement and Cohen's kappa per question. */
function agreement(files: string[]) {
  const [first, second] = files.map((file) => JSON.parse(readFileSync(file, "utf8")) as Ratings);
  const shared = Object.keys(first.pairs ?? {}).filter((id) => second.pairs?.[id]);
  console.log(`${shared.length} shared pairs between ${first.rater || files[0]} and ${second.rater || files[1]}`);
  for (const question of ["natural", "fit", "tooMuch"] as const) {
    const answered = shared.filter((id) => first.pairs![id][question] && second.pairs![id][question]);
    const n = answered.length;
    if (!n) continue;
    const observed = answered.filter((id) => first.pairs![id][question] === second.pairs![id][question]).length / n;
    const categories = new Set(answered.flatMap((id) => [first.pairs![id][question], second.pairs![id][question]]));
    let expected = 0;
    for (const category of categories) {
      const p1 = answered.filter((id) => first.pairs![id][question] === category).length / n;
      const p2 = answered.filter((id) => second.pairs![id][question] === category).length / n;
      expected += p1 * p2;
    }
    const kappa = expected === 1 ? 1 : (observed - expected) / (1 - expected);
    console.log(`  ${question.padEnd(8)} agree ${pct(observed)}  kappa ${kappa.toFixed(2)}  (n=${n})`);
  }
  console.log("Kappa: < 0.2 slight, 0.2–0.4 fair, 0.4–0.6 moderate, 0.6–0.8 substantial.");
}

// ---------------------------------------------------------------- rater page

function raterHtml(run: string, pairs: Pair[], sceneClips: Render[]): string {
  const data = JSON.stringify({ run, pairs, sceneClips: sceneClips.map((r) => ({ id: `${r.scene}--${r.config}`, file: r.file, scene: r.scene })) });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Scene partner listening test · ${run}</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif;line-height:1.45}
body{max-width:820px;margin:32px auto;padding:0 16px}
h1{font-size:1.4rem}.muted{opacity:.7;font-size:.9rem}
.pair{border:1px solid #8884;border-radius:12px;padding:16px;margin:18px 0}
.ctx{opacity:.65;font-size:.9rem;margin:0 0 6px}.line{font-size:1.1rem;margin:4px 0 12px}
.players{display:flex;gap:16px;flex-wrap:wrap}.players div{flex:1 1 240px}
audio{width:100%}
.q{display:grid;grid-template-columns:1fr auto;gap:8px 12px;align-items:center;margin-top:12px;font-size:.95rem}
.q label{margin-right:10px;white-space:nowrap}
.done{color:#2a7}.bar{position:sticky;top:0;background:Canvas;padding:10px 0;border-bottom:1px solid #8884;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
button{padding:8px 14px;border-radius:8px;border:1px solid #8886;background:#8882;cursor:pointer}
input[type=text]{padding:6px 8px;border-radius:6px;border:1px solid #8886}
</style></head><body>
<div class="bar"><strong>Listening test</strong><span class="muted" id="progress"></span>
<label>Your name <input type="text" id="rater" placeholder="e.g. Jess"></label>
<button id="download">Download ratings</button><button id="shuffle">Shuffle order</button></div>
<h1>Which read sounds like a real scene partner?</h1>
<p class="muted">Each pair is the same line in two reads, in random order. Listen to both, then answer. Ratings save in this browser as you go; download the JSON at the end and send it back. Don't peek at key.json.</p>
<div id="pairs"></div>
<div id="clips"></div>
<script>
const DATA=${data};
const store=JSON.parse(localStorage.getItem('ratings:'+DATA.run)||'{"pairs":{},"clips":{}}');
const save=()=>{store.rater=document.getElementById('rater').value;localStorage.setItem('ratings:'+DATA.run,JSON.stringify(store));progress();};
document.getElementById('rater').value=store.rater||'';
let order=DATA.pairs.map((_,i)=>i);
function radio(name,opts,current,onpick){return opts.map(([v,l])=>'<label><input type="radio" name="'+name+'" value="'+v+'"'+(current===v?' checked':'')+'> '+l+'</label>').join('');}
function render(){
  const root=document.getElementById('pairs');root.innerHTML='';
  order.forEach((i,n)=>{const p=DATA.pairs[i];const r=store.pairs[p.id]||{};
    const el=document.createElement('section');el.className='pair';
    el.innerHTML='<div class="muted">'+(n+1)+' / '+DATA.pairs.length+(r.natural&&r.fit&&r.tooMuch?' <span class="done">✓</span>':'')+'</div>'
      +p.context.map(c=>'<p class="ctx">'+c+'</p>').join('')
      +'<p class="line"><strong>'+p.speaker+':</strong> '+p.text+'</p>'
      +'<div class="players"><div><strong>A</strong><audio controls preload="none" src="'+p.A+'"></audio></div><div><strong>B</strong><audio controls preload="none" src="'+p.B+'"></audio></div></div>'
      +'<div class="q"><span>Sounds more like a real reader</span><span>'+radio(p.id+':natural',[['A','A'],['B','B'],['tie','Same']],r.natural)+'</span>'
      +'<span>Fits the moment better</span><span>'+radio(p.id+':fit',[['A','A'],['B','B'],['tie','Same']],r.fit)+'</span>'
      +'<span>Over the top?</span><span>'+radio(p.id+':tooMuch',[['A','A'],['B','B'],['both','Both'],['neither','Neither']],r.tooMuch)+'</span></div>';
    el.querySelectorAll('input[type=radio]').forEach(inp=>inp.addEventListener('change',()=>{const [id,q]=inp.name.split(':');store.pairs[id]=store.pairs[id]||{};store.pairs[id][q]=inp.value;save();render();}));
    root.appendChild(el);});
  const clips=document.getElementById('clips');clips.innerHTML='';
  if(DATA.sceneClips.length){clips.innerHTML='<h2>Scene clips</h2><p class="muted">Whole scenes rendered in one pass. Rate each on its own.</p>';
    DATA.sceneClips.forEach(c=>{const r=store.clips[c.id]||{};const el=document.createElement('section');el.className='pair';
      el.innerHTML='<p class="line"><strong>'+c.scene+'</strong> <span class="muted">'+c.id+'</span></p><audio controls preload="none" src="'+c.file+'"></audio>'
        +'<div class="q"><span>Sounds like real people (1–5)</span><span>'+radio(c.id+':natural',[1,2,3,4,5].map(v=>[String(v),String(v)]),r.natural)+'</span>'
        +'<span>Fits the scene (1–5)</span><span>'+radio(c.id+':fit',[1,2,3,4,5].map(v=>[String(v),String(v)]),r.fit)+'</span>'
        +'<span>Over the top (1–5)</span><span>'+radio(c.id+':tooMuch',[1,2,3,4,5].map(v=>[String(v),String(v)]),r.tooMuch)+'</span></div>';
      el.querySelectorAll('input[type=radio]').forEach(inp=>inp.addEventListener('change',()=>{const [id,q]=inp.name.split(':');store.clips[id]=store.clips[id]||{};store.clips[id][q]=inp.value;save();}));
      clips.appendChild(el);});}
  progress();
}
function progress(){const done=DATA.pairs.filter(p=>{const r=store.pairs[p.id];return r&&r.natural&&r.fit&&r.tooMuch;}).length;document.getElementById('progress').textContent=done+' of '+DATA.pairs.length+' pairs rated';}
document.getElementById('rater').addEventListener('input',save);
document.getElementById('shuffle').addEventListener('click',()=>{order.sort(()=>Math.random()-0.5);render();});
document.getElementById('download').addEventListener('click',()=>{save();const name=(store.rater||'rater').replace(/[^a-z0-9]+/gi,'-').toLowerCase();
  const blob=new Blob([JSON.stringify({run:DATA.run,rater:store.rater||'',pairs:store.pairs,clips:store.clips},null,2)],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='ratings-'+name+'.json';a.click();});
render();
</script></body></html>`;
}

// ---------------------------------------------------------------- main

async function main() {
  if (flag("list")) {
    for (const config of Object.values(CONFIGS)) {
      console.log(`${config.name.padEnd(14)} ${config.changes}`);
    }
    return;
  }
  if (flag("ai-rate")) {
    const run = value("run");
    if (!run) {
      console.error("--ai-rate needs --run <name>.");
      process.exit(1);
    }
    const limit = value("pairs") ? Number(value("pairs")) : null;
    await aiRate(run, limit);
    return;
  }
  // --agreement takes the two files that follow it.
  const agreementAt = argv.indexOf("--agreement");
  const agreementFiles = agreementAt === -1 ? [] : argv.slice(agreementAt + 1, agreementAt + 3).filter((arg) => !arg.startsWith("--"));
  if (agreementFiles.length === 2) {
    agreement(agreementFiles);
    return;
  }
  const scoreFiles = values("score");
  if (scoreFiles.length) {
    const run = value("run");
    if (!run) {
      console.error("--score needs --run <name> (the folder the pairs came from).");
      process.exit(1);
    }
    score(run, scoreFiles);
    return;
  }

  if (DRY_RUN) {
    // api/casting.ts constructs an Anthropic client at import time; a
    // placeholder is enough to inspect the plan and run the checks.
    process.env.ANTHROPIC_API_KEY ??= "dry-run";
    runChecks();
  } else {
    requireEnv("ANTHROPIC_API_KEY");
  }
  const elevenKey = DRY_RUN || DIRECT_ONLY ? "" : requireEnv("ELEVENLABS_API_KEY");

  const configNames = values("config");
  const configs = (configNames.length ? configNames : ["baseline"]).map((name) => {
    const config = CONFIGS[name];
    if (!config) {
      console.error(`Unknown config "${name}". --list shows them.`);
      process.exit(1);
    }
    return config;
  });
  if (!DRY_RUN && !configs.some((config) => config.name === PAIR_WITH) && configs.length > 1) {
    console.warn(`Note: ${PAIR_WITH} isn't in this run, so no blind pairs will be written.`);
  }

  const fixture = loadFixture();
  const onlyLines = new Set(values("lines").flatMap((list) => list.split(",")));
  const onlyScenes = new Set(values("scene"));
  const targets = fixture.targets.filter(
    (target) =>
      (!QUICK || target.quick) &&
      (!onlyLines.size || onlyLines.has(target.id)) &&
      (!onlyScenes.size || onlyScenes.has(target.scene)),
  );
  if (!targets.length) {
    console.error("No targets selected.");
    process.exit(1);
  }
  const sceneById = new Map(fixture.scenes.map((scene) => [scene.id, scene]));
  const scenes = [...new Set(targets.map((target) => target.scene))].map((id) => sceneById.get(id)!);
  const prompts = [...new Set(configs.map((config) => config.prompt))];

  // Imported after the env check above (see dry-run note).
  const { DIRECTOR_PROMPT } = await import("../../api/casting.js");
  const { BIG_DELIVERY_TAGS } = await import("../../api/tts.js");
  const { sanitizePerformance } = await import("../../api/_direction.js");
  const promptText = (variant: TtsConfig["prompt"]) => (variant === "warm" ? WARM_DIRECTOR_PROMPT : DIRECTOR_PROMPT);

  // Voices: catalog names in the fixture → ids, like casting resolves them.
  const voiceIds = new Map<string, string>();
  if (!DRY_RUN && elevenKey) {
    const { fetchVoices } = await import("../../api/_elevenlabs.js");
    const catalog = await fetchVoices(elevenKey);
    for (const name of new Set(Object.values(fixture.voices))) {
      const match = catalog.find((voice) => voice.name.split(/\s+-\s+/)[0].trim().toLowerCase() === name.toLowerCase());
      if (match) voiceIds.set(name, match.id);
      else console.warn(`Voice "${name}" not in the catalog; using the default voice.`);
    }
  }
  const voiceFor = (speaker: string) => {
    const name = fixture.voices[speaker];
    return { name, id: voiceIds.get(name) ?? (DRY_RUN ? `<${name}>` : DEFAULT_VOICE_ID) };
  };

  const run = value("run") ?? new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const outDir = join(OUT_ROOT, run);

  const renderCount = configs.reduce(
    (sum, config) => sum + (config.context === "dialogue" ? scenes.length : targets.length),
    0,
  );
  console.log(`Run "${run}": ${targets.length} lines in ${scenes.length} scenes × ${configs.length} config(s)`);
  console.log(`  director calls: ${prompts.length * scenes.length} (${prompts.join(", ")} × ${scenes.length} scenes)`);
  console.log(`  renders: ${DIRECT_ONLY ? 0 : renderCount}`);
  for (const config of configs) console.log(`  ${config.name.padEnd(14)} ${config.changes}`);
  if (DRY_RUN) {
    console.log("\nDry run: no API calls made, nothing written.");
    return;
  }

  // The director, once per prompt variant per scene; the whole scene goes in
  // one call, as api/casting.ts's directLines sends the whole script.
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const anthropic = new Anthropic();
  const directed = new Map<string, (string | null)[]>();
  for (const variant of prompts) {
    for (const scene of scenes) {
      const response = await anthropic.messages.create({
        model: DIRECTOR_MODEL,
        max_tokens: 8000,
        output_config: { effort: "low" },
        system: promptText(variant),
        messages: [{ role: "user", content: `Scene dialogue, one line per row:\n${numberedRows(scene)}` }],
      });
      const textBlock = response.content.find((block) => block.type === "text");
      const entries = extractJsonArray(textBlock?.type === "text" ? textBlock.text : "") ?? [];
      directed.set(
        `${variant}:${scene.id}`,
        scene.lines.map((line, index) => sanitizePerformance(entries[index], line.text)),
      );
      console.log(`directed ${scene.id} (${variant}): ${entries.length} entries`);
    }
  }

  mkdirSync(outDir, { recursive: true });

  // Resolves to the characters billed; a non-OK response past the retries
  // throws, and the caller records it against the render and carries on.
  async function elevenPost(path: string, body: unknown, file: string): Promise<number | undefined> {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(`https://api.elevenlabs.io/v1/${path}`, {
        method: "POST",
        headers: { "xi-api-key": elevenKey, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (response.status === 429 && attempt < 3) {
        const wait = Number(response.headers.get("retry-after") ?? 5) * 1000;
        console.warn(`429 from ElevenLabs; waiting ${wait}ms`);
        await new Promise((resolve) => setTimeout(resolve, wait));
        continue;
      }
      if (!response.ok) throw new Error(`ElevenLabs ${response.status}: ${(await response.text()).slice(0, 200)}`);
      writeFileSync(join(outDir, file), Buffer.from(await response.arrayBuffer()));
      const cost = Number(response.headers.get("character-cost"));
      return Number.isFinite(cost) ? cost : undefined;
    }
  }
  let billed = 0;

  const renders: Render[] = [];
  const audits: Record<string, LineAudit[]> = {};

  for (const config of configs) {
    audits[config.name] = [];
    const voiceSettings = (stability: number) => ({
      stability,
      ...(config.style !== undefined ? { style: config.style } : {}),
      ...(config.similarityBoost !== undefined ? { similarity_boost: config.similarityBoost } : {}),
      ...(config.speakerBoost !== undefined ? { use_speaker_boost: config.speakerBoost } : {}),
      ...(config.speed !== undefined ? { speed: config.speed } : {}),
    });

    // What each line of a scene reads as under this config.
    const lineReads = (scene: Scene) =>
      scene.lines.map((line, index) => {
        const content = toContent(line.direction);
        const deliveryTag = deliveryTagFromContent(content);
        const shaped = shapeLine(line.text, deliveryTag, directed.get(`${config.prompt}:${scene.id}`)?.[index] ?? null);
        const beat = beatFromContent(content) ?? (shaped.beat as "short" | "long" | null) ?? null;
        return { line, deliveryTag: deliveryTag ?? null, ...shaped, beat, stability: stabilityFor(config, !!deliveryTag && BIG_DELIVERY_TAGS.has(deliveryTag)) };
      });

    for (const scene of scenes) {
      const reads = lineReads(scene);
      const sceneTargets = targets.filter((target) => target.scene === scene.id);

      for (const target of sceneTargets) {
        const read = reads[target.index];
        audits[config.name].push(auditLine(target.id, target.label, read.deliveryTag ? read.text : read.markup, read.line.text));
      }

      if (config.context === "dialogue") {
        if (DIRECT_ONLY) continue;
        // Whole scene in one call, chunked at the documented character limit.
        let chunk: { text: string; voice_id: string }[] = [];
        let chars = 0;
        let part = 0;
        const flush = async () => {
          if (!chunk.length) return;
          part += 1;
          const file = `${scene.id}--${config.name}${part > 1 ? `-part${part}` : ""}.mp3`;
          const render: Render = { line: scene.id, config: config.name, file, scene: scene.id, speaker: "", voice: "", voiceId: "", model: config.model, text: chunk.map((input) => input.text).join("\n"), markup: null, deliveryTag: null, beat: null, stability: config.stability };
          try {
            render.cost = await elevenPost("text-to-dialogue", { inputs: chunk, model_id: config.model, settings: { stability: config.stability } }, file);
            billed += render.cost ?? 0;
            console.log(`rendered ${file} (${render.cost ?? "?"} chars)`);
          } catch (error) {
            render.error = error instanceof Error ? error.message : String(error);
            console.warn(`FAILED ${file}: ${render.error}`);
          }
          renders.push(render);
          chunk = [];
          chars = 0;
        };
        for (const read of reads) {
          if (chars + read.text.length > DIALOGUE_CHAR_LIMIT) await flush();
          chunk.push({ text: read.text, voice_id: voiceFor(read.line.speaker).id });
          chars += read.text.length;
        }
        await flush();
        continue;
      }

      for (const target of sceneTargets) {
        const read = reads[target.index];
        const voice = voiceFor(read.line.speaker);
        const file = `${target.id}--${config.name}.mp3`;
        const render: Render = {
          line: target.id, config: config.name, file, speaker: read.line.speaker, voice: voice.name, voiceId: voice.id,
          model: config.model, text: read.text, markup: read.markup, deliveryTag: read.deliveryTag, beat: read.beat, stability: read.stability,
        };
        if (!DIRECT_ONLY) {
          const previous = reads.slice(0, target.index).reverse().find((candidate) => candidate.line.text.trim());
          const next = reads.slice(target.index + 1).find((candidate) => candidate.line.text.trim());
          try {
            render.cost = await elevenPost(
              `text-to-speech/${encodeURIComponent(voice.id)}`,
              {
                text: read.text,
                model_id: config.model,
                voice_settings: voiceSettings(read.stability),
                ...(config.context === "prev-next" && previous ? { previous_text: previous.line.text.slice(-CONTEXT_CHAR_LIMIT) } : {}),
                ...(config.context === "prev-next" && next ? { next_text: next.line.text.slice(0, CONTEXT_CHAR_LIMIT) } : {}),
              },
              file,
            );
            billed += render.cost ?? 0;
            console.log(`rendered ${file} (${render.cost ?? "?"} chars)`);
          } catch (error) {
            render.error = error instanceof Error ? error.message : String(error);
            console.warn(`FAILED ${file}: ${render.error}`);
          }
        }
        renders.push(render);
      }
    }
  }

  // Audit report.
  console.log(`\nMarkup audit (${targets.length} lines)`);
  console.log(`${"config".padEnd(14)} directed shaped  cued-flat  fit  neutral-over  diversity`);
  const auditSummary: Record<string, ReturnType<typeof summarizeAudit>> = {};
  for (const config of configs) {
    const summary = summarizeAudit(audits[config.name]);
    auditSummary[config.name] = summary;
    console.log(
      `${config.name.padEnd(14)} ${pct(summary.directedShare)}     ${pct(summary.shapedShare)}    ${pct(summary.cuedButFlat)}     ${pct(summary.familyMatchRate)}  ${pct(summary.neutralOverTagged)}          ${pct(summary.tagDiversity)}`,
    );
  }
  console.log("directed: any markup · shaped: tag/pacing/emphasis · cued-flat: cued lines with no shaping (lower is better) · fit: tags in the label's family · neutral-over: neutral lines given an emotional tag (lower is better)");
  writeFileSync(join(outDir, "audit.json"), JSON.stringify({ run, summary: auditSummary, lines: audits }, null, 2) + "\n");

  // Blind pairs: every non-reference config against the reference, per line.
  const pairs: Pair[] = [];
  const pairKey: PairKey = {};
  const reference = renders.filter((render) => render.config === PAIR_WITH && !render.scene && !render.error);
  for (const config of configs) {
    if (config.name === PAIR_WITH || config.context === "dialogue") continue;
    for (const render of renders.filter((candidate) => candidate.config === config.name && !candidate.scene && !candidate.error)) {
      const base = reference.find((candidate) => candidate.line === render.line);
      if (!base) continue;
      const target = targets.find((candidate) => candidate.id === render.line)!;
      const scene = sceneById.get(target.scene)!;
      const context = scene.lines.slice(Math.max(0, target.index - 2), target.index).map((line) => `${line.speaker}: ${line.text}`);
      const testIsA = Math.random() < 0.5;
      const id = `${render.line}--${config.name}`;
      pairs.push({ id, line: render.line, speaker: scene.lines[target.index].speaker, text: scene.lines[target.index].text, context, A: testIsA ? render.file : base.file, B: testIsA ? base.file : render.file });
      pairKey[id] = { A: testIsA ? config.name : PAIR_WITH, B: testIsA ? PAIR_WITH : config.name };
    }
  }

  const failed = renders.filter((render) => render.error).length;
  writeFileSync(join(outDir, "key.json"), JSON.stringify({ run, pairWith: PAIR_WITH, configs: configs.map((config) => config.name), billedCharacters: billed, renders }, null, 2) + "\n");
  if (!DIRECT_ONLY) console.log(`\nElevenLabs billed ${billed} characters for this run${failed ? `; ${failed} render(s) failed (see key.json)` : ""}.`);
  if (!DIRECT_ONLY) {
    writeFileSync(join(outDir, "pairs.json"), JSON.stringify(pairs, null, 2) + "\n");
    writeFileSync(join(outDir, "pair-key.json"), JSON.stringify(pairKey, null, 2) + "\n");
    writeFileSync(join(outDir, "rater.html"), raterHtml(run, pairs, renders.filter((render) => render.scene)));
    console.log(`\nWrote ${renders.length} renders, ${pairs.length} blind pairs → ${outDir}`);
    console.log(`Open ${join(outDir, "rater.html")} to rate; score with: npm run bench:emotion -- --score ratings-<name>.json --run ${run}`);
    console.log(`Acoustics: python3 benchmarks/voice/acoustics.py ${outDir}`);
  } else {
    console.log(`\nWrote audit → ${outDir} (no audio: --direct-only)`);
  }
  if (!existsSync(join(outDir, "key.json"))) throw new Error("key.json missing");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
