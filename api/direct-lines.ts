import Anthropic from "@anthropic-ai/sdk";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAuthRateLimited } from "./_entitlement.js";

const client = new Anthropic();

// Lines beyond this cap simply get no tag — the client aligns tags by index,
// so truncation degrades gracefully on very long scripts.
const MAX_LINES = 400;

// Delivery tags Eleven v3 handles well as inline audio tags. The model must
// pick from this list (or null) so the TTS layer never sees free-form text.
const TAG_VOCABULARY = [
  "angry", "annoyed", "cold", "sad", "somber", "crying", "cheerful", "warm",
  "excited", "playful", "teasing", "flirtatious", "nervous", "hesitant",
  "scared", "terrified", "surprised", "shocked", "confused", "curious",
  "sarcastic", "deadpan", "mocking", "threatening", "pleading", "desperate",
  "tired", "resigned", "whispers", "shouts", "laughs", "sighs",
];

const DIRECTOR_PROMPT = `You are a voice director preparing an AI scene partner to read lines opposite a human actor. For each numbered dialogue line, decide how a skilled actor would deliver it given the surrounding scene, and assign at most one delivery tag.

Allowed tags (use these exactly, nothing else):
${TAG_VOCABULARY.join(", ")}

Rules:
- Most lines are conversationally neutral: use null unless the scene context clearly calls for a specific emotion or vocal delivery. Tag at most about a third of the lines.
- Judge from context, not just the line itself — a line's delivery depends on what was said before and where the scene is going.
- Return ONLY a JSON array, no prose and no markdown fences, with exactly one entry (a tag string or null) per input line, in input order.

Example output: [null, "nervous", null, null, "angry", null]`;

function extractJsonArray(raw: string): string | null {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  return raw.slice(start, end + 1);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const auth = await requireAuthRateLimited(req, res);
  if (!auth) return;

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set" });
  }

  const { lines } = (req.body ?? {}) as {
    lines?: Array<{ speaker?: string; text?: string }>;
  };
  if (
    !Array.isArray(lines) ||
    !lines.length ||
    lines.some((line) => !line || typeof line !== "object")
  ) {
    return res.status(400).json({ error: "No lines provided" });
  }

  const capped = lines.slice(0, MAX_LINES);
  const numbered = capped
    .map(
      (line, index) =>
        `${index}| ${typeof line.speaker === "string" && line.speaker ? line.speaker : "—"}: ${typeof line.text === "string" ? line.text : ""}`,
    )
    .join("\n");

  try {
    const stream = client.messages.stream({
      model: "claude-opus-5",
      max_tokens: 16000,
      // A well-specified per-line classification — low effort keeps latency
      // and cost down while adaptive thinking stays available for hard scenes.
      output_config: { effort: "low" },
      system: DIRECTOR_PROMPT,
      messages: [
        {
          role: "user",
          content: `Scene dialogue, one line per row:\n${numbered}`,
        },
      ],
    });
    const response = await stream.finalMessage();

    const textBlock = response.content.find((block) => block.type === "text");
    const json = extractJsonArray(
      textBlock?.type === "text" ? textBlock.text : "",
    );
    if (!json) {
      return res.status(500).json({ error: "Line direction failed" });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return res.status(500).json({ error: "Line direction failed" });
    }
    if (!Array.isArray(parsed)) {
      return res.status(500).json({ error: "Line direction failed" });
    }

    const allowed = new Set(TAG_VOCABULARY);
    // One entry per submitted line: unknown tags and any overflow past the
    // model's output (or MAX_LINES) collapse to null.
    const tags: (string | null)[] = lines.map((_, index) => {
      const value = parsed[index];
      if (typeof value !== "string") return null;
      const tag = value.trim().toLowerCase().replace(/^\[|\]$/g, "");
      return allowed.has(tag) ? tag : null;
    });

    return res.status(200).json({ tags });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Line direction error:", message);
    return res.status(500).json({ error: message });
  }
}
