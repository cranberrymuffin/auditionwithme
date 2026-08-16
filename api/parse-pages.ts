import Anthropic from "@anthropic-ai/sdk";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireRehearsalGrant } from "./_entitlement.js";
import { splitSpeech } from "./_screenplay.js";

// Parses a chunk of scanned script pages (rendered to JPEGs client-side) with
// vision. Scanned PDFs have no text layer, so the fast text path in
// parse-script.ts can't run — instead the client splits the document into
// page-range chunks and calls this endpoint for each chunk in parallel, then
// merges the results (src/lib/scannedScript.ts).

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "20mb",
    },
  },
};

const client = new Anthropic();

const MAX_IMAGES_PER_CHUNK = 20;

const SYSTEM_PROMPT = `You are a script processing assistant for an actor's rehearsal tool. The actor has this script for an audition and needs it split into dialogue steps to practice their lines. You will be given scanned page images from the play or screenplay, in order. They are a CONSECUTIVE EXCERPT from a longer script — earlier and later pages may exist.

Read the printed text and split all dialogue into an ordered sequence of "steps".

Rules:
1. Walk the pages top to bottom, in order. Each speech (a speaker label plus everything that character says until the next speaker label) becomes exactly one step.
2. "speaker" is the canonical character name — strip continuity suffixes such as (CONT'D), (V.O.), (O.S.).
3. If the first spoken text on the first page continues a speech begun on an earlier page (no speaker label above it), output it as the first step with "speaker": "".
4. "line" is what the character speaks in that step, joined into one string. Rejoin words hyphenated across line breaks. A parenthetical or brief stage direction that falls IN THE MIDDLE of the speech (e.g. an actor's aside like "(turning drunk sad on a dime)") stays embedded in "line", wrapped in parentheses, exactly where it occurs — do not pull it out or move it.
4b. MUSICAL NUMBERS: do NOT transcribe song lyrics — not even one line. This includes sections marked "MUSIC #", and any sung verse formatted like dialogue (stacked short rhyming lines under speaker labels, often a parody of a well-known song), including songs continuing from a previous page. Replace each song with ONE step: "speaker": "", empty "line", and a "direction" summarizing it, e.g. "MUSIC #4 — In The Navy parody, sung by EVERYBODY". Resume normal steps at the first spoken (non-sung) dialogue after the song.
5. "direction" (optional) holds ONLY a stage direction or scene description that appears BEFORE the speaker begins talking — never text that falls inside the speech itself (that stays in "line" per rule 4). Omit the field when there is none.
6. Transcribe what is printed — do not invent, rewrite, summarize, or translate. Ignore handwritten annotations, crossed-out lines, page headers, footers, and page numbers.
6b. AUDITION SIDES MARKUP — these pages may be audition sides with production markup. Apply it:
   - Content crossed out by strikethrough lines, diagonal slashes, or X boxes is CUT — exclude it from steps entirely.
   - START/END (or Start/Stop, often with arrows) margin cues bound the selection: exclude content before a START cue and after an END cue, until the next START. "Sc. 1"/"Scene 2" labels next to cues just number the selections.
   - Sections marked FYI or set off by a vertical margin line are context only — exclude them from steps.
   - Margin notes with acting instructions (often colored or handwritten) go into the adjacent step's "direction".
   - Page furniture ("Role: X", "PG 1 OF 7", "1/4", sides service watermarks) is not content.
   - Two dialogue columns printed side by side are simultaneous speeches — output the left column's speech as one step, then the right column's as the next.
7. "characters": every unique speaking character on THESE pages, canonical name, in order of first appearance.
8. Detect the primary spoken language of the dialogue: ISO 639-1 "languageCode" plus English "languageName".

Output format: return ONLY valid JSON, no prose, no markdown fences:
{
  "characters": ["CHARACTER A", "CHARACTER B"],
  "languageCode": "en",
  "languageName": "English",
  "steps": [
    { "speaker": "<character name or empty string>", "line": "<spoken text>", "direction": "<non-spoken text, optional>" }
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

  const { images, preferOriginalLanguage } = (req.body ?? {}) as {
    images?: string[];
    preferOriginalLanguage?: boolean;
  };

  if (
    !Array.isArray(images) ||
    images.length === 0 ||
    !images.every((i) => typeof i === "string" && i)
  ) {
    return res.status(400).json({ error: "No page images provided" });
  }
  if (images.length > MAX_IMAGES_PER_CHUNK) {
    return res
      .status(413)
      .json({
        error: `Too many pages in one chunk (max ${MAX_IMAGES_PER_CHUNK})`,
      });
  }

  try {
    const modelStartedAt = performance.now();
    const stream = client.messages.stream({
      // Sonnet, not Haiku: Haiku's output content filter deterministically
      // blocks bulk transcription of scanned script pages (copyright
      // classifier); Sonnet 5 handles the same pages fine. Chunks still run in
      // parallel client-side to bound wall-clock time.
      model: "claude-sonnet-5",
      // Chunks are small (5 pages) and the schema avoids echoing text twice, so
      // 8K is generous headroom. Keeping responses short matters beyond cost:
      // very long verbatim transcriptions trip the API's content filter.
      max_tokens: 8000,
      // Same rationale as parse-script.ts: thinking adds latency with no gain
      // on this transcription task.
      thinking: { type: "disabled" },
      system: preferOriginalLanguage
        ? `${SYSTEM_PROMPT}\n\nBILINGUAL EDITIONS: when the pages print the same dialogue in two languages (an original and a translation, often side by side), transcribe the ORIGINAL language for "line" — not the English translation. Set "languageCode"/"languageName" to that original language.`
        : SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            ...images.map((data): Anthropic.ImageBlockParam => ({
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data },
            })),
            {
              type: "text",
              text: "Process these consecutive scanned script pages as instructed and return the JSON result.",
            },
          ],
        },
      ],
    });

    const response = await stream.finalMessage();
    const modelDurationMs = performance.now() - modelStartedAt;

    if (response.stop_reason === "max_tokens") {
      console.error(
        `parse-pages: output truncated at max_tokens (images=${images.length}, output=${response.usage.output_tokens})`,
      );
      return res
        .status(500)
        .json({
          error: "These pages hold too much text to process in one chunk.",
        });
    }

    const textBlock = response.content.find((b) => b.type === "text");
    const raw = textBlock?.type === "text" ? textBlock.text : "";
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1) {
      return res.status(500).json({ error: "Script parsing failed" });
    }

    // Compact wire schema from the model ("line"/"direction") to halve output
    // tokens; expand to the app's verbalLine/content step shape here.
    type RawStep = { speaker?: string; line?: string; direction?: string };
    let parsed: {
      characters?: string[];
      languageCode?: string;
      languageName?: string;
      steps?: RawStep[];
    };
    try {
      parsed = JSON.parse(raw.slice(start, end + 1)) as typeof parsed;
    } catch {
      console.error("parse-pages: malformed JSON from model");
      return res.status(500).json({ error: "Script parsing failed" });
    }

    const validSteps =
      Array.isArray(parsed.steps) &&
      parsed.steps.every(
        (step) =>
          step &&
          (step.speaker === undefined || typeof step.speaker === "string") &&
          (step.line === undefined || typeof step.line === "string") &&
          (step.direction === undefined || typeof step.direction === "string"),
      );
    const validCharacters =
      parsed.characters === undefined ||
      (Array.isArray(parsed.characters) &&
        parsed.characters.every((character) => typeof character === "string"));

    if (!validSteps || !validCharacters) {
      return res.status(500).json({ error: "Script parsing failed" });
    }

    const steps = (parsed.steps ?? [])
      .map((step) => {
        const direction = step.direction?.trim() ?? "";
        // Parentheticals embedded mid-speech (e.g. "(turning drunk sad on a
        // dime)") stay inline in step.line per the prompt — split them out
        // in their original position rather than always leading the step.
        const { content: spokenContent, verbalLine } = splitSpeech(
          step.line?.trim() ?? "",
        );
        return {
          speaker: step.speaker?.trim() ?? "",
          verbalLine,
          content: [
            ...(direction
              ? [{ kind: "nonverbal" as const, text: direction }]
              : []),
            ...spokenContent,
          ],
        };
      })
      .filter((step) => step.content.length > 0);

    res.setHeader("Server-Timing", `model;dur=${modelDurationMs.toFixed(1)}`);
    return res.status(200).json({
      characters: parsed.characters ?? [],
      languageCode:
        typeof parsed.languageCode === "string" ? parsed.languageCode : "en",
      languageName:
        typeof parsed.languageName === "string"
          ? parsed.languageName
          : "English",
      steps,
      modelDurationMs: Math.round(modelDurationMs),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Claude API error:", message);
    return res.status(500).json({ error: message });
  }
}
