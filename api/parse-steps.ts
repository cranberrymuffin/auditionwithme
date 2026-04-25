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
- A NON-VERBAL line is anything not spoken: stage directions, action notes, parentheticals, sound cues, transitions, etc.
- A SPEAKER label is a character name that precedes dialogue (e.g. "JOHN" or "MARY (V.O.)").

Your job:
1. Walk the script top to bottom.
2. Each verbal line becomes exactly one step.
3. For each step, identify the speaker — the character name label immediately before the dialogue. If no speaker label is present, use "".
4. For each step, build a "content" array of every line that belongs to this step, in their original script order. Each element is either:
   - { "kind": "verbal", "text": "<verbatim spoken line>" }
   - { "kind": "nonverbal", "text": "<verbatim non-verbal line>" }
5. Assign non-verbal lines to the step they are most semantically related to. A non-verbal line between two verbal lines goes to whichever it is contextually closer to (e.g. a reaction attaches to the prior verbal; a setup attaches to the next verbal).
6. Also include the verbal line text as a top-level "verbalLine" field (identical to the verbal content item's text).
7. Do not include speaker name labels in the content array — extract them as the "speaker" field only.
8. Do not invent, rewrite, summarize, translate, or reorder any text. Copy lines verbatim.
9. Do not drop any non-speaker line. Every non-empty, non-speaker line must appear in content.
10. If the script has zero verbal lines, return an empty steps array.

Output format: return ONLY valid JSON, no prose, no markdown fences:
{
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

    type RawStep = { speaker: string; verbalLine: string; content: { kind: string; text: string }[] };
    let parsed: { steps?: RawStep[] };
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
