import type { VercelRequest, VercelResponse } from "@vercel/node";
import { fetchVoices } from "./_elevenlabs.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "ELEVENLABS_API_KEY is not set" });
  }

  try {
    const voices = await fetchVoices(apiKey);
    return res.status(200).json({ voices });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Voices fetch error:", message);
    return res.status(500).json({ error: message });
  }
}
