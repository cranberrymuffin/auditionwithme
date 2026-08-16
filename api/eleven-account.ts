import type { VercelRequest, VercelResponse } from "@vercel/node";
import { fetchVoices } from "./_elevenlabs.js";
import { requireAuthRateLimited } from "./_entitlement.js";

async function listVoices(res: VercelResponse, apiKey: string) {
  try {
    const voices = await fetchVoices(apiKey);
    return res.status(200).json({ voices });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Voices fetch error:", message);
    return res.status(500).json({ error: message });
  }
}

// Mints a short-lived single-use token so the browser can open the
// Scribe v2 Realtime WebSocket without ever seeing the API key.
async function mintScribeToken(res: VercelResponse, apiKey: string) {
  try {
    const upstream = await fetch(
      "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe",
      {
        method: "POST",
        headers: { "xi-api-key": apiKey },
      },
    );

    if (!upstream.ok) {
      const err = await upstream.text();
      console.error("Scribe token error:", err);
      return res.status(upstream.status).json({ error: err });
    }

    // Response may be a JSON object or a bare token string — handle both
    const raw = await upstream.text();
    let token = raw.trim().replace(/^"|"$/g, "");
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed?.token) token = parsed.token;
    } catch {
      // bare string token — already handled
    }
    if (!token) {
      return res.status(502).json({ error: "No token in upstream response" });
    }
    return res.status(200).json({ token });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Scribe token error:", message);
    return res.status(500).json({ error: message });
  }
}

// Combines the voice-catalog and scribe-token endpoints — they were already
// split by HTTP method, so no action param is needed. Keeps the function
// count under Vercel Hobby's 12-per-deployment cap.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const auth = await requireAuthRateLimited(req, res);
  if (!auth) return;

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "ELEVENLABS_API_KEY is not set" });
  }

  if (req.method === "GET") return listVoices(res, apiKey);
  if (req.method === "POST") return mintScribeToken(res, apiKey);
  return res.status(405).json({ error: "Method not allowed" });
}
