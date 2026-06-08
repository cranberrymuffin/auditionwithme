import Anthropic from "@anthropic-ai/sdk";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const client = new Anthropic();

const VOICES = [
  { id: "CwhRBWXzGAHq8TQ4Fs17", name: "Roger", gender: "male", age: "middle_aged", accent: "american", description: "Laid-Back, Casual, Resonant" },
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah", gender: "female", age: "young", accent: "american", description: "Mature, Reassuring, Confident" },
  { id: "FGY2WhTYpPnrIDTdsKH5", name: "Laura", gender: "female", age: "young", accent: "american", description: "Enthusiast, Quirky Attitude" },
  { id: "IKne3meq5aSn9XLyUdCD", name: "Charlie", gender: "male", age: "young", accent: "australian", description: "Deep, Confident, Energetic" },
  { id: "JBFqnCBsd6RMkjVDRZzb", name: "George", gender: "male", age: "middle_aged", accent: "british", description: "Warm, Captivating Storyteller" },
  { id: "N2lVS1w4EtoT3dr4eOWO", name: "Callum", gender: "male", age: "middle_aged", accent: "american", description: "Husky Trickster" },
  { id: "SAz9YHcvj6GT2YYXdXww", name: "River", gender: "neutral", age: "middle_aged", accent: "american", description: "Relaxed, Neutral, Informative" },
  { id: "SOYHLrjzK2X1ezoPC6cr", name: "Harry", gender: "male", age: "young", accent: "american", description: "Fierce Warrior" },
  { id: "TX3LPaxmHKxFdv7VOQHJ", name: "Liam", gender: "male", age: "young", accent: "american", description: "Energetic, Social Media Creator" },
  { id: "Xb7hH8MSUJpSbSDYk0k2", name: "Alice", gender: "female", age: "middle_aged", accent: "british", description: "Clear, Engaging Educator" },
  { id: "XrExE9yKIg1WjnnlVkGX", name: "Matilda", gender: "female", age: "middle_aged", accent: "american", description: "Knowledgeable, Professional" },
  { id: "bIHbv24MWmeRgasZH58o", name: "Will", gender: "male", age: "young", accent: "american", description: "Relaxed Optimist" },
  { id: "cgSgspJ2msm6clMCkdW9", name: "Jessica", gender: "female", age: "young", accent: "american", description: "Playful, Bright, Warm" },
  { id: "cjVigY5qzO86Huf0OWal", name: "Eric", gender: "male", age: "middle_aged", accent: "american", description: "Smooth, Trustworthy" },
  { id: "hpp4J3VqNfWAUOO0d1Us", name: "Bella", gender: "female", age: "middle_aged", accent: "american", description: "Professional, Bright, Warm" },
  { id: "iP95p4xoKVk53GoZ742B", name: "Chris", gender: "male", age: "middle_aged", accent: "american", description: "Charming, Down-to-Earth" },
  { id: "nPczCjzI2devNBz1zQrb", name: "Brian", gender: "male", age: "middle_aged", accent: "american", description: "Deep, Resonant and Comforting" },
  { id: "onwK4e9ZLuTAKqWW03F9", name: "Daniel", gender: "male", age: "middle_aged", accent: "british", description: "Steady Broadcaster" },
  { id: "pFZP5JQG7iQjIQuC4Bku", name: "Lily", gender: "female", age: "middle_aged", accent: "british", description: "Velvety Actress" },
  { id: "pNInz6obpgDQGcFmaJgB", name: "Adam", gender: "male", age: "middle_aged", accent: "american", description: "Dominant, Firm" },
  { id: "pqHfZKP75CvOlQylNhV4", name: "Bill", gender: "male", age: "old", accent: "american", description: "Wise, Mature, Balanced" },
];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set" });
  }

  const { characters } = req.body as {
    characters: Array<{ name: string; sampleLines: string[] }>;
  };

  if (!characters?.length) {
    return res.status(400).json({ error: "No characters provided" });
  }

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
