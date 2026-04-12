import Anthropic from "@anthropic-ai/sdk";
import type { VercelRequest, VercelResponse } from "@vercel/node";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "4mb",
    },
  },
};

const client = new Anthropic();

const SYSTEM_PROMPT = `You are a script parser for an actor's audition practice tool. You receive a raw audition script and must split it into an ordered sequence of "steps."

Definitions:
- A VERBAL line is spoken dialogue (what a character says out loud).
- A NON-VERBAL line is anything not spoken: stage directions, action notes, scene headings, character name labels on their own line, parentheticals, sound cues, transitions, etc.

Your job:
1. Walk the script top to bottom.
2. Identify every verbal line. Each verbal line becomes exactly one step.
3. For every non-verbal line, decide which verbal line it is most semantically related to, and attach it to that step's nonVerbalLines array. A non-verbal line sitting between two verbal lines should go to whichever verbal line it is contextually closer to in meaning (e.g., an action describing a reaction to what was just said attaches to the previous verbal line; a stage direction setting up what is about to be said attaches to the next verbal line).
4. Preserve the original script order of non-verbal lines within each step's nonVerbalLines array.
5. Do not invent, rewrite, summarize, translate, or reorder any text. Copy lines verbatim.
6. Do not drop any line. Every non-empty line from the input must appear either as a verbalLine or inside some step's nonVerbalLines.
7. If the script has zero verbal lines, return an empty steps array.

Output format: return ONLY valid JSON, no prose, no markdown fences:
{
  "steps": [
    { "verbalLine": "<verbatim spoken line>", "nonVerbalLines": ["<verbatim non-verbal line>", ...] }
  ]
}`;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set" });
  }

  const { scriptText } = req.body as { scriptText?: string };

  if (typeof scriptText !== "string" || !scriptText.trim()) {
    return res.status(400).json({ error: "No script text provided" });
  }

  try {
    const response = await client.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: scriptText,
        },
      ],
    });

    const raw =
      response.content[0].type === "text" ? response.content[0].text : "";

    // Strip any accidental prose around the JSON
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1) {
      return res.status(500).json({ error: "Step parsing failed" });
    }

    let parsed: { steps?: { verbalLine: string; nonVerbalLines: string[] }[] };
    try {
      parsed = JSON.parse(raw.slice(start, end + 1)) as typeof parsed;
    } catch {
      console.error("parse-steps: malformed JSON from model");
      return res.status(500).json({ error: "Step parsing failed" });
    }

    if (!Array.isArray(parsed.steps)) {
      return res.status(500).json({ error: "Step parsing failed" });
    }

    return res.status(200).json({ steps: parsed.steps });
  } catch (err) {
    console.error("parse-steps error:", err instanceof Error ? err.message : err);
    return res.status(500).json({ error: "Step parsing failed" });
  }
}
