import type { VercelRequest, VercelResponse } from "@vercel/node";

export const config = {
  api: { bodyParser: { sizeLimit: "20mb" } },
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ELEVENLABS_API_KEY is not set" });

  const { audioData, mimeType } = req.body as { audioData?: string; mimeType?: string };
  if (!audioData) return res.status(400).json({ error: "No audio data" });

  try {
    const audioBuffer = Buffer.from(audioData, "base64");
    const formData = new FormData();
    formData.append(
      "file",
      new Blob([audioBuffer], { type: mimeType ?? "audio/webm" }),
      "audio.webm"
    );
    formData.append("model_id", "scribe_v1");

    const upstream = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: formData,
    });

    if (!upstream.ok) {
      const err = await upstream.text();
      return res.status(upstream.status).json({ error: err });
    }

    const result = await upstream.json() as { text?: string };
    return res.status(200).json({ text: result.text ?? "" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("STT error:", message);
    return res.status(500).json({ error: message });
  }
}
