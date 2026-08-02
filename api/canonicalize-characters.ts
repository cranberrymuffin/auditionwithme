import Anthropic from "@anthropic-ai/sdk";
import type { VercelRequest, VercelResponse } from "@vercel/node";

// Chunked scanned-page parsing (parse-pages.ts) transcribes speaker names as
// printed, so the same character surfaces under several spellings across
// chunks ("WIDOW TWANKEY" / "WIDOW T" / "WIDOW T." plus OCR typos). This maps
// every raw name to a canonical one so the role picker shows one entry per
// character. Tiny call — names only, no script text.

const client = new Anthropic();

const SYSTEM_PROMPT = `You are given speaker names collected from different sections of ONE play script. Some entries are the same character written differently: abbreviations ("WIDOW T" for "WIDOW TWANKEY"), trailing initials or punctuation, or OCR typos. Others are genuinely distinct characters or group labels.

Return ONLY valid JSON mapping EVERY input name to its canonical form:
{"canonical": {"WIDOW T": "WIDOW TWANKEY", "WIDOW TWANKEY": "WIDOW TWANKEY", "ALADDIN": "ALADDIN"}}

Rules:
- Prefer the fullest spelling that appears in the input as the canonical form.
- Map obvious OCR typos to the correct name.
- Merge group-label duplicates (e.g. "EVERYONE"/"EVERYBODY" → one form).
- NEVER merge names that could plausibly be different characters.
- Every input name must appear exactly once as a key.`;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set" });
  }

  const { characters } = (req.body ?? {}) as { characters?: string[] };
  if (!Array.isArray(characters) || characters.length === 0 || characters.length > 200 ||
      !characters.every((c) => typeof c === "string" && c.length <= 80)) {
    return res.status(400).json({ error: "No character names provided" });
  }

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: JSON.stringify(characters) }],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    const raw = textBlock?.type === "text" ? textBlock.text : "";
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1) {
      return res.status(500).json({ error: "Character matching failed" });
    }

    let parsed: { canonical?: Record<string, string> };
    try {
      parsed = JSON.parse(raw.slice(start, end + 1)) as typeof parsed;
    } catch {
      return res.status(500).json({ error: "Character matching failed" });
    }

    const canonical: Record<string, string> = {};
    for (const name of characters) {
      const mapped = parsed.canonical?.[name];
      canonical[name] = typeof mapped === "string" && mapped ? mapped : name;
    }

    return res.status(200).json({ canonical });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Claude API error:", message);
    return res.status(500).json({ error: message });
  }
}
