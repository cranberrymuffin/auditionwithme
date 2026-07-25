import Anthropic from "@anthropic-ai/sdk";
import type { VercelRequest, VercelResponse } from "@vercel/node";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "20mb",
    },
  },
};

const client = new Anthropic();

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

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set" });
  }

  const { pdfData, scriptText } = (req.body ?? {}) as { pdfData?: string; scriptText?: string };

  if (!pdfData && !scriptText?.trim()) {
    return res.status(400).json({ error: "No script text or PDF data provided" });
  }
  if (scriptText && scriptText.length > 250_000) {
    return res.status(413).json({ error: "Extracted script text is too large" });
  }

  try {
    const userContent: Anthropic.MessageCreateParams["messages"][number]["content"] = scriptText?.trim()
      ? `Process the extracted script text below as instructed and return the JSON result. Page breaks are marked explicitly.\n\n<SCRIPT>\n${scriptText.trim()}\n</SCRIPT>`
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
      max_tokens: 16000,
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

    // Sonnet 5 runs adaptive thinking by default, so a `thinking` block
    // precedes the `text` block — don't assume content[0] is the text block.
    const textBlock = response.content.find((b) => b.type === "text");
    const raw = textBlock?.type === "text" ? textBlock.text : "";

    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1) {
      return res.status(500).json({ error: "Script parsing failed" });
    }

    type RawStep = { speaker: string; verbalLine: string; content: { kind: string; text: string }[] };
    let parsed: { characters?: string[]; languageCode?: string; languageName?: string; steps?: RawStep[] };
    try {
      parsed = JSON.parse(raw.slice(start, end + 1)) as typeof parsed;
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
      processingMode: scriptText?.trim() ? "text" : "pdf-fallback",
      modelDurationMs: Math.round(modelDurationMs),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Claude API error:", message);
    return res.status(500).json({ error: message });
  }
}
