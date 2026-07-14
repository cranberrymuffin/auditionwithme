import Anthropic from "@anthropic-ai/sdk";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { fetchVoices } from "./_elevenlabs.js";

const client = new Anthropic();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set" });
  }
  const elevenLabsKey = process.env.ELEVENLABS_API_KEY;
  if (!elevenLabsKey) {
    return res.status(500).json({ error: "ELEVENLABS_API_KEY is not set" });
  }

  const { characters } = req.body as {
    characters: Array<{ name: string; sampleLines: string[] }>;
  };

  if (!characters?.length) {
    return res.status(400).json({ error: "No characters provided" });
  }

  const VOICES = await fetchVoices(elevenLabsKey);
  const voiceList = VOICES.map(
    (v) => `- ${v.name} (${v.gender}, ${v.age}, ${v.accent}): ${v.description} [id: ${v.id}]`
  ).join("\n");

  const characterList = characters
    .map((c) => `- ${c.name}: "${c.sampleLines.slice(0, 2).join(" / ")}"`)
    .join("\n");

  const prompt = `You are casting voices for a script reading app. Match each character to the most fitting voice based on their name, apparent gender, age, and dialogue style.

Available voices:
${voiceList}

Characters and sample lines:
${characterList}

Rules:
- Assign a different voice to each character where possible
- Prioritise gender match, then age, then personality fit
- Return only a JSON object mapping character names to voice IDs

Example output: {"HAMLET": "pNInz6obpgDQGcFmaJgB", "OPHELIA": "pFZP5JQG7iQjIQuC4Bku"}`;

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "{}";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in response");

    const voices = JSON.parse(jsonMatch[0]);
    return res.status(200).json({ voices });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Character voice matching error:", message);
    return res.status(500).json({ error: message });
  }
}
