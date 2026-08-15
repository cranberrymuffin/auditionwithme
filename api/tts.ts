import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAuthRateLimited } from "./_entitlement.js";

const DEFAULT_VOICE_ID = "pFZP5JQG7iQjIQuC4Bku"; // Lily — fallback if no character voice assigned

// Eleven v3 is the expressive acting model: it takes inline audio tags like
// "[angry]" and uses previous/next-line context for prosody. Multilingual v2
// is the fallback when the account or voice can't serve v3 — v2 would read
// audio tags out loud, so tags are only ever prepended on the v3 request.
const EXPRESSIVE_MODEL = "eleven_v3";
const FALLBACK_MODEL = "eleven_multilingual_v2";

type Intensity = "subtle" | "natural" | "dramatic";

// v3 stability only accepts the discrete values 1 (Robust), 0.5 (Natural),
// and 0 (Creative — most emotional, least consistent between takes).
const V3_STABILITY: Record<Intensity, number> = {
  subtle: 1,
  natural: 0.5,
  dramatic: 0,
};

const V2_SETTINGS: Record<Intensity, { stability: number; style: number }> = {
  subtle: { stability: 0.65, style: 0.15 },
  natural: { stability: 0.45, style: 0.35 },
  dramatic: { stability: 0.3, style: 0.55 },
};

// Cap on how much surrounding dialogue is sent as prosody context.
const CONTEXT_CHAR_LIMIT = 600;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const auth = await requireAuthRateLimited(req, res);
  if (!auth) return;

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "ELEVENLABS_API_KEY is not set" });
  }

  const { text, voiceId, previousText, nextText, deliveryTag, intensity } =
    (req.body ?? {}) as {
      text?: string;
      voiceId?: string;
      previousText?: string;
      nextText?: string;
      deliveryTag?: string;
      intensity?: string;
    };
  if (!text?.trim()) {
    return res.status(400).json({ error: "No text provided" });
  }

  const level: Intensity =
    intensity === "subtle" || intensity === "dramatic" ? intensity : "natural";
  const tag =
    typeof deliveryTag === "string" && /^[a-z][a-z ]{0,23}$/i.test(deliveryTag.trim())
      ? deliveryTag.trim().toLowerCase()
      : null;
  const context = {
    ...(typeof previousText === "string" && previousText.trim()
      ? { previous_text: previousText.slice(-CONTEXT_CHAR_LIMIT) }
      : {}),
    ...(typeof nextText === "string" && nextText.trim()
      ? { next_text: nextText.slice(0, CONTEXT_CHAR_LIMIT) }
      : {}),
  };

  const synthesize = (modelId: string) =>
    fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId || DEFAULT_VOICE_ID)}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          modelId === EXPRESSIVE_MODEL
            ? {
                text: tag ? `[${tag}] ${text}` : text,
                model_id: modelId,
                voice_settings: { stability: V3_STABILITY[level] },
                ...context,
              }
            : {
                text,
                model_id: modelId,
                voice_settings: {
                  ...V2_SETTINGS[level],
                  similarity_boost: 0.75,
                  use_speaker_boost: true,
                },
                ...context,
              },
        ),
      },
    );

  try {
    let upstream = await synthesize(EXPRESSIVE_MODEL);
    if (!upstream.ok && upstream.status >= 400 && upstream.status < 500) {
      const detail = await upstream.text();
      console.warn(
        `ElevenLabs ${EXPRESSIVE_MODEL} request failed (${upstream.status}); retrying with ${FALLBACK_MODEL}:`,
        detail,
      );
      upstream = await synthesize(FALLBACK_MODEL);
    }

    if (!upstream.ok) {
      const err = await upstream.text();
      console.error("ElevenLabs error:", err);
      return res.status(upstream.status).json({ error: err });
    }

    const audio = await upstream.arrayBuffer();
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", audio.byteLength);
    return res.status(200).send(Buffer.from(audio));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("TTS error:", message);
    return res.status(500).json({ error: message });
  }
}
