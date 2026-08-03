import Anthropic from "@anthropic-ai/sdk";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { buildSteps, collectSpeakerCandidates } from "./_screenplay.js";
import { cleanLayoutLines, flattenLayout, parseScreenplayLayout, type LayoutLineTuple } from "./_layout.js";
import { detectLanguage } from "./_language.js";
import { requireRehearsalGrant } from "./_entitlement.js";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "20mb",
    },
  },
};

const client = new Anthropic();

// ── Fast path: deterministic segmentation + a small classification call ──
// The old approach asked the model to regenerate the whole script as JSON, so
// output tokens (and latency) scaled with script length — a 33-page play took
// ~100s and overflowed max_tokens. Instead, _screenplay.ts segments the text in
// code, and Haiku only returns the tiny decisions regex can't make (which
// candidate labels are real characters, which orphan lines are stage directions
// vs wrapped dialogue, where front/end matter ends). Output stays at a few
// hundred tokens regardless of script length, so the whole parse is seconds.

const CLASSIFIER_PROMPT = `You classify the structure of a play or screenplay whose text was extracted from a PDF. Each line is prefixed with a 0-based line number ("N| text"). Deterministic code will segment the dialogue itself; your job is ONLY to classify what code cannot.

Return ONLY valid JSON, no prose, no markdown fences:
{
  "languageCode": "en",
  "languageName": "English",
  "characters": [{"label": "Author", "name": "Author"}],
  "dialogueStart": 62,
  "dialogueEnd": 1090,
  "stageDirections": [103, 125],
  "junk": [66, 210]
}

Field rules:
- "languageCode"/"languageName": primary language of the DIALOGUE (ISO 639-1 code + English name).
- "characters": which of the provided candidate labels are real speaking characters. "label" must be the candidate exactly as given; "name" is the canonical display name (usually the same, with continuity suffixes like (CONT'D)/(V.O.) stripped). Exclude scene headings, sound cues, and false-positive labels.
- "dialogueStart"/"dialogueEnd": inclusive line range of the actual performance text. Exclude title pages, cast lists, licensing/copyright text and other front matter before it, and end matter (license text, author bio, catalogs) after it.
- "stageDirections": line numbers within [dialogueStart, dialogueEnd] that are stage directions, scene descriptions, or action lines — lines that are NOT spoken, NOT a speaker-labeled line, and NOT a wrapped continuation of the previous spoken line. List each line number individually — never compress into ranges, and never include a spoken line. Be careful: a line that continues the previous line's sentence (wrapped dialogue) must NOT be listed.
- "junk": line numbers within the range that are page headers/footers or other repeated non-script noise. (Lines that are only a page number are already handled — don't list those.)
Every non-speaker line in the range that you don't list is treated as a continuation of the previous speech.`;

type ClassifierResult = {
  languageCode?: string;
  languageName?: string;
  characters?: { label?: string; name?: string }[];
  dialogueStart?: number;
  dialogueEnd?: number;
  stageDirections?: (number | string)[];
  junk?: (number | string)[];
};

type ParsePayload = {
  characters: string[];
  languageCode: string;
  languageName: string;
  steps: unknown[];
  processingMode: string;
  modelDurationMs: number;
};

function extractJson(raw: string): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  return raw.slice(start, end + 1);
}

async function parseTextFast(scriptText: string): Promise<ParsePayload | null> {
  const lines = scriptText.split("\n").map((line) => line.trim());
  const candidates = collectSpeakerCandidates(lines);
  if (candidates.size === 0) return null;

  const candidateList = [...candidates.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => `- "${label}" (${count} occurrences)`)
    .join("\n");
  const numbered = lines.map((line, i) => `${i}| ${line}`).join("\n");

  const modelStartedAt = performance.now();
  const stream = client.messages.stream({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 8000,
    system: CLASSIFIER_PROMPT,
    messages: [
      {
        role: "user",
        content: `Candidate speaker labels found by regex (confirm which are real characters):\n${candidateList}\n\nNumbered script text:\n${numbered}`,
      },
    ],
  });
  const response = await stream.finalMessage();
  const modelDurationMs = performance.now() - modelStartedAt;

  if (response.stop_reason === "max_tokens") {
    console.warn("parse-script: classifier hit max_tokens; falling back to full parse");
    return null;
  }

  const textBlock = response.content.find((b) => b.type === "text");
  const json = extractJson(textBlock?.type === "text" ? textBlock.text : "");
  if (!json) return null;

  let result: ClassifierResult;
  try {
    result = JSON.parse(json) as ClassifierResult;
  } catch {
    console.warn("parse-script: classifier returned malformed JSON; falling back");
    return null;
  }

  const labels = new Map<string, string>();
  for (const character of result.characters ?? []) {
    if (typeof character?.label === "string" && character.label && candidates.has(character.label)) {
      labels.set(character.label, typeof character.name === "string" && character.name ? character.name : character.label);
    }
  }
  if (labels.size === 0) return null;

  // Accepts numbers and "start-end" range strings.
  const asLineSet = (values: unknown): Set<number> => {
    const set = new Set<number>();
    for (const value of Array.isArray(values) ? values : []) {
      if (Number.isInteger(value)) {
        set.add(value as number);
      } else if (typeof value === "string") {
        const range = /^(\d+)\s*-\s*(\d+)$/.exec(value.trim());
        if (range) {
          const start = Number(range[1]);
          const end = Math.min(Number(range[2]), start + 500);
          for (let i = start; i <= end; i++) set.add(i);
        } else if (/^\d+$/.test(value.trim())) {
          set.add(Number(value.trim()));
        }
      }
    }
    return set;
  };

  const { steps, characters } = buildSteps(lines, {
    labels,
    stageDirectionLines: asLineSet(result.stageDirections),
    junkLines: asLineSet(result.junk),
    start: Number.isInteger(result.dialogueStart) ? result.dialogueStart! : 0,
    end: Number.isInteger(result.dialogueEnd) ? result.dialogueEnd! : lines.length - 1,
  });

  // Degenerate segmentation (weird format regex didn't really fit) → let the
  // slow-but-thorough full parse handle it.
  if (steps.length < 3) return null;

  return {
    characters,
    languageCode: typeof result.languageCode === "string" ? result.languageCode : "en",
    languageName: typeof result.languageName === "string" ? result.languageName : "English",
    steps,
    processingMode: "text-fast",
    modelDurationMs: Math.round(modelDurationMs),
  };
}

// ── Fallback path: full model parse (PDF vision input, or unusual text formats) ──

const SYSTEM_PROMPT = `You are a script processing assistant for an actor's audition practice tool. You will be given a PDF containing audition sides or a script. It may include annotations, strikethroughs, margin notes, highlighted sections, and other markings made by directors, casting agents, or actors.

Your job has two parts.

PART 1 — Produce a clean script internally.
1. Identify which lines are ACTIVE — ignore any lines that are struck through or crossed out.
2. Extract all character names and their dialogue.
3. Include relevant stage directions.
4. Note any important annotations that affect how lines should be performed by folding them into the stage directions or dialogue context.
The clean script should be the definitive version of the script the actor should use for their audition, formatted as:

CHARACTER NAME
Their dialogue here.

(stage direction)

Next lines continue...

PART 2 — Split the clean script from Part 1 into an ordered sequence of "steps".

Definitions:
- A VERBAL line is spoken dialogue (what a character says out loud).
- A NON-VERBAL line is anything not spoken: stage directions, action notes, parentheticals, sound cues, transitions, etc.
- A SPEAKER label is a character name that precedes dialogue (e.g. "JOHN" or "MARY (V.O.)").

Steps rules:
1. Walk the clean script top to bottom.
2. Each verbal line becomes exactly one step.
3. For each step, identify the speaker — the character name label immediately before the dialogue. If no speaker label is present, use "".
4. For each step, build a "content" array of every line that belongs to this step, in their original script order. Each element is either:
   - { "kind": "verbal", "text": "<verbatim spoken line>" }
   - { "kind": "nonverbal", "text": "<verbatim non-verbal line>" }
5. Assign non-verbal lines to the step they are most semantically related to. A non-verbal line between two verbal lines goes to whichever it is contextually closer to (e.g. a reaction attaches to the prior verbal; a setup attaches to the next verbal).
6. Also include the verbal line text as a top-level "verbalLine" field (identical to the verbal content item's text).
7. Do not include speaker name labels in the content array — extract them as the "speaker" field only.
8. Do not invent, rewrite, summarize, translate, or reorder any text. Copy lines verbatim from the clean script.
9. Do not drop any non-speaker line. Every non-empty, non-speaker line must appear in content.
10. If the clean script has zero verbal lines, return an empty steps array.
11. Also produce a top-level "characters" array listing every unique speaking character exactly once, using their canonical name — strip continuity suffixes such as (CONT'D), (V.O.), (O.S.), (O.C.), (PRE-LAP), etc. Order by first appearance.
12. Detect the primary spoken language of the dialogue and return its ISO 639-1 code as "languageCode" and its English name as "languageName".

Do not return the full clean script separately. It would duplicate the text in the steps and waste response time.

Output format: return ONLY valid JSON, no prose, no markdown fences:
{
  "characters": ["CHARACTER A", "CHARACTER B"],
  "languageCode": "en",
  "languageName": "English",
  "steps": [
    {
      "speaker": "<character name or empty string>",
      "verbalLine": "<verbatim spoken line>",
      "content": [
        { "kind": "nonverbal", "text": "<verbatim non-verbal line>" },
        { "kind": "verbal", "text": "<verbatim spoken line>" }
      ]
    }
  ]
}`;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const auth = await requireRehearsalGrant(req, res);
  if (!auth) return;

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set" });
  }

  const { pdfData, scriptText, layout } = (req.body ?? {}) as {
    pdfData?: string;
    scriptText?: string;
    layout?: { lines?: LayoutLineTuple[] };
  };

  const rawLayoutLines: LayoutLineTuple[] | null =
    Array.isArray(layout?.lines) &&
    layout.lines.length > 0 &&
    layout.lines.length <= 30_000 &&
    layout.lines.every(
      (l) => Array.isArray(l) && l.length === 3 && typeof l[0] === "number" && typeof l[1] === "number" && typeof l[2] === "string"
    )
      ? layout.lines
      : null;
  const cleaned = rawLayoutLines ? cleanLayoutLines(rawLayoutLines) : null;
  const layoutLines = cleaned?.lines ?? null;
  // A large share of unreadable original-language lines means this is a
  // bilingual edition where only the translation survives text extraction —
  // surfaced so the client can offer reading the original from page images.
  const unreadableOriginalLanguage =
    cleaned !== null &&
    cleaned.droppedMojibake >= 100 &&
    cleaned.droppedMojibake / (cleaned.droppedMojibake + cleaned.lines.length) >= 0.08;

  // Strategy chain: screenplay-layout (deterministic) → labeled-text
  // (regex + small classifier) → full model parse.
  const effectiveText = scriptText?.trim() || (layoutLines ? flattenLayout(layoutLines) : "");

  if (!pdfData && !effectiveText) {
    return res.status(400).json({ error: "No script text or PDF data provided" });
  }
  if (effectiveText.length > 250_000) {
    return res.status(413).json({ error: "Extracted script text is too large" });
  }

  try {
    // Strategy 1: deterministic indent-based screenplay parsing — no model
    // call at all, so it's instant and reproducible.
    if (layoutLines) {
      const parsed = parseScreenplayLayout(layoutLines);
      if (parsed) {
        const dialogue = parsed.steps.map((step) => step.verbalLine).filter(Boolean).join(" ");
        const language = detectLanguage(dialogue);
        res.setHeader("Server-Timing", "model;dur=0");
        return res.status(200).json({
          characters: parsed.characters,
          languageCode: language.code,
          languageName: language.name,
          steps: parsed.steps,
          processingMode: "screenplay-layout",
          modelDurationMs: 0,
          unreadableOriginalLanguage,
        });
      }
    }

    // Strategy 2: fast text path; falls through to the full parse when the
    // format doesn't segment cleanly.
    if (effectiveText) {
      try {
        const fast = await parseTextFast(effectiveText);
        if (fast) {
          res.setHeader("Server-Timing", `model;dur=${fast.modelDurationMs}`);
          return res.status(200).json({ ...fast, unreadableOriginalLanguage });
        }
      } catch (fastError) {
        console.warn("parse-script: fast path failed; falling back to full parse", fastError);
      }
    }

    const userContent: Anthropic.MessageCreateParams["messages"][number]["content"] = effectiveText
      ? `Process the extracted script text below as instructed and return the JSON result. Page breaks are marked explicitly.\n\n<SCRIPT>\n${effectiveText}\n</SCRIPT>`
      : [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: pdfData!,
            },
          },
          {
            type: "text",
            text: "Process this script PDF as instructed and return the JSON result.",
          },
        ];
    const modelStartedAt = performance.now();
    const stream = client.messages.stream({
      model: "claude-sonnet-5",
      // Sonnet 5's streamed output ceiling — long scripts need the headroom
      // since the full parse echoes every line back as JSON.
      max_tokens: 64000,
      // Sonnet 5 runs adaptive thinking by default, which roughly triples output
      // tokens and latency on this task (measured: ~53s/6.4K tokens with thinking
      // vs ~16s/2K tokens without, for near-identical visible output) with no
      // measurable quality gain on this well-specified extraction/formatting task.
      thinking: { type: "disabled" },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: userContent,
        },
      ],
    });

    const response = await stream.finalMessage();
    const modelDurationMs = performance.now() - modelStartedAt;

    if (response.stop_reason === "max_tokens") {
      console.error(
        `parse-script: output truncated at max_tokens (input=${response.usage.input_tokens}, output=${response.usage.output_tokens})`
      );
      return res.status(500).json({ error: "This script is too long to process. Try uploading only the pages you need." });
    }

    // A `thinking` block can precede the `text` block — don't assume content[0].
    const textBlock = response.content.find((b) => b.type === "text");
    const raw = textBlock?.type === "text" ? textBlock.text : "";

    const json = extractJson(raw);
    if (!json) {
      return res.status(500).json({ error: "Script parsing failed" });
    }

    type RawStep = { speaker: string; verbalLine: string; content: { kind: string; text: string }[] };
    let parsed: { characters?: string[]; languageCode?: string; languageName?: string; steps?: RawStep[] };
    try {
      parsed = JSON.parse(json) as typeof parsed;
    } catch {
      console.error("parse-script: malformed JSON from model");
      return res.status(500).json({ error: "Script parsing failed" });
    }

    const validSteps = Array.isArray(parsed.steps) && parsed.steps.every((step) =>
      step &&
      typeof step.speaker === "string" &&
      typeof step.verbalLine === "string" &&
      Array.isArray(step.content) &&
      step.content.every((line) =>
        line &&
        (line.kind === "verbal" || line.kind === "nonverbal") &&
        typeof line.text === "string"
      )
    );
    const validCharacters = parsed.characters === undefined || (
      Array.isArray(parsed.characters) && parsed.characters.every((character) => typeof character === "string")
    );

    if (!validSteps || !validCharacters) {
      return res.status(500).json({ error: "Script parsing failed" });
    }

    res.setHeader("Server-Timing", `model;dur=${modelDurationMs.toFixed(1)}`);
    return res.status(200).json({
      characters: parsed.characters ?? [],
      languageCode: typeof parsed.languageCode === "string" ? parsed.languageCode : "en",
      languageName: typeof parsed.languageName === "string" ? parsed.languageName : "English",
      steps: parsed.steps,
      processingMode: effectiveText ? "text-full" : "pdf-fallback",
      modelDurationMs: Math.round(modelDurationMs),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Claude API error:", message);
    return res.status(500).json({ error: message });
  }
}
