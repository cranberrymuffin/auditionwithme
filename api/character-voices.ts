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

  const { characters, languageCode = "en" } = (req.body ?? {}) as {
    characters: Array<{ name: string; sampleLines: string[] }>;
    languageCode?: string;
  };

  if (!Array.isArray(characters) || !characters.length || characters.some(
    (character) => !character || typeof character.name !== "string" || !Array.isArray(character.sampleLines)
  )) {
    return res.status(400).json({ error: "No characters provided" });
  }

  let allVoices;
  try {
    allVoices = await fetchVoices(elevenLabsKey);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Voice catalog unavailable";
    console.error("Voice catalog error:", message);
    return res.status(502).json({ error: "Voice catalog unavailable" });
  }
  if (!allVoices.length) {
    return res.status(502).json({ error: "No voices are available" });
  }
  const languageVoices = allVoices.filter((voice) => voice.language === languageCode);
  const VOICES = languageVoices.length ? languageVoices : allVoices;
  const voiceList = VOICES.map(
    (v) => `- ${v.name} (${v.gender}, ${v.age}, ${v.accent}, ${v.tone}) [id: ${v.id}]`
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
- The script language is ${languageCode}; only choose a voice from the supplied language-compatible list
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

    const rawVoices: unknown = JSON.parse(jsonMatch[0]);
    if (!rawVoices || typeof rawVoices !== "object" || Array.isArray(rawVoices)) {
      throw new Error("Invalid voice mapping");
    }

    const characterNames = new Set(characters.map((character) => character.name));
    const voiceIds = new Set(VOICES.map((voice) => voice.id));
    const voices = Object.fromEntries(
      Object.entries(rawVoices).filter(
        ([character, voiceId]) => characterNames.has(character) && typeof voiceId === "string" && voiceIds.has(voiceId)
      )
    );
    return res.status(200).json({ voices });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Character voice matching error:", message);
    return res.status(500).json({ error: message });
  }
}
