import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAuthRateLimited } from "./_entitlement.js";
import { sanitizePerformance } from "./_direction.js";
import {
  fetchElevenLabs,
  holdPregenIfBusy,
  relayConcurrency,
  type ConcurrencyReading,
} from "./_elevenlabs.js";

export { shouldHoldPregen } from "./_elevenlabs.js";

const DEFAULT_VOICE_ID = "pFZP5JQG7iQjIQuC4Bku"; // Lily — fallback if no character voice assigned

// Eleven v3 is the expressive acting model: it takes inline audio tags like
// "[angry]". Multilingual v2 is the fallback when the account or voice can't
// serve v3 — v2 would read audio tags out loud, so markup only ever goes on
// the v3 request. Eleven v3 does not accept previous_text or next_text; the AI
// director already uses scene context to produce the inline performance.
const EXPRESSIVE_MODEL = "eleven_v3";
const FALLBACK_MODEL = "eleven_multilingual_v2";

// Fixed at the old "natural" preset. The client still sends an `intensity`
// field (pinned to "natural" and kept in its cache key), but it's ignored
// here: a global intensity knob made every line louder at once, which beta
// testers heard as over-acting. Emotion now comes from per-line audio tags,
// plus each character's own Emotion setting (see v2Stability below).
const V2_SETTINGS = { stability: 0.45, style: 0.35 };

// How far a character's Emotion setting (-1 very reserved … 1 very
// expressive, src/lib/characterDelivery.ts) moves stability off its natural
// value: the full range spans 0.6 of it, lower being more expressive.
const EMOTION_STABILITY_SPAN = 0.3;

/** The request's emotion setting, made safe (missing or junk → natural). */
export function parseEmotion(emotion: unknown): number {
  return typeof emotion === "number" && Number.isFinite(emotion)
    ? Math.min(Math.max(emotion, -1), 1)
    : 0;
}

const clampStability = (stability: number) =>
  Math.round(Math.min(Math.max(stability, 0), 1) * 100) / 100;

export function v2Stability(emotion = 0): number {
  return clampStability(V2_SETTINGS.stability - emotion * EMOTION_STABILITY_SPAN);
}

// Cap on how much surrounding dialogue is sent as prosody context — roughly
// the last/next five or six lines, enough to carry the scene's emotional arc.
const CONTEXT_CHAR_LIMIT = 1800;

// Script parentheticals that genuinely call for a big, uncontained read.
// The AI director can't produce these (they're kept out of its vocabulary in
// api/casting.ts) — only an explicit "(shouting)"-style direction in the
// script itself, mapped by src/lib/delivery.ts, can.
export const BIG_DELIVERY_TAGS = new Set([
  "shouts",
  "screams",
  "crying",
  "terrified",
  "panicked",
]);

// Ordinary lines read at 0.3: looser than v3's Natural preset (0.5), which
// sounded flat and synthetic, but well short of Creative (0), which
// exaggerated every tagged line into something beta testers called "over
// the top" for an audition reader. Emotion still comes mainly from the
// director's scene-aware audio tags. Creative is kept only for the script's
// own big-delivery parentheticals, whatever the character's Emotion setting:
// the script itself asked for it. Otherwise that setting moves the 0.3 —
// Very expressive reaches Creative, Very reserved goes past Natural.
export function v3Stability(bigDelivery: boolean, emotion = 0): number {
  return bigDelivery ? 0 : clampStability(0.3 - emotion * EMOTION_STABILITY_SPAN);
}

// Pre-generation hold: see holdPregenIfBusy in _elevenlabs.ts. This
// function's own view of the account (each route is its own instance).
const lastSeenConcurrency: ConcurrencyReading = { current: 0, max: 3, updatedAt: 0 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const auth = await requireAuthRateLimited(req, res, {
    bucket: "tts",
    maxPerWindow: 600,
  });
  if (!auth) return;

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "ELEVENLABS_API_KEY is not set" });
  }

  const {
    text,
    voiceId,
    previousText,
    nextText,
    deliveryTag,
    performance,
    emotion: rawEmotion,
  } = (req.body ?? {}) as {
      text?: string;
      voiceId?: string;
      previousText?: string;
      nextText?: string;
      deliveryTag?: string;
      /** AI-director markup of `text`: inline v3 audio tags + pacing punctuation. */
      performance?: string;
      /** The character's Emotion setting, -1 … 1 (missing = natural). */
      emotion?: unknown;
    };
  const emotion = parseEmotion(rawEmotion);
  if (!text?.trim()) {
    return res.status(400).json({ error: "No text provided" });
  }

  if (holdPregenIfBusy(req, res, lastSeenConcurrency)) return;

  const tag =
    typeof deliveryTag === "string" &&
    /^[a-z][a-z ]{0,23}$/i.test(deliveryTag.trim())
      ? deliveryTag.trim().toLowerCase()
      : null;
  // Markup that fails validation (altered words, junk tags) is discarded, not
  // rejected — the line still reads fine unadorned. An explicit deliveryTag
  // (script parenthetical) outranks director markup; the client already
  // enforces that, so treat a request carrying both as tag-only.
  const markup = tag ? null : sanitizePerformance(performance, text);
  const expressiveText = markup ?? (tag ? `[${tag}] ${text}` : text);
  const context = {
    ...(typeof previousText === "string" && previousText.trim()
      ? { previous_text: previousText.slice(-CONTEXT_CHAR_LIMIT) }
      : {}),
    ...(typeof nextText === "string" && nextText.trim()
      ? { next_text: nextText.slice(0, CONTEXT_CHAR_LIMIT) }
      : {}),
  };

  const synthesize = (modelId: string) =>
    fetchElevenLabs(
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
                text: expressiveText,
                model_id: modelId,
                // `tag` is the explicit deliveryTag (script parenthetical) only —
                // director markup never makes a line "big".
                voice_settings: {
                  stability: v3Stability(
                    tag != null && BIG_DELIVERY_TAGS.has(tag),
                    emotion,
                  ),
                },
              }
            : {
                text,
                model_id: modelId,
                voice_settings: {
                  ...V2_SETTINGS,
                  stability: v2Stability(emotion),
                  similarity_boost: 0.75,
                  use_speaker_boost: true,
                },
                ...context,
              },
        ),
      },
    );

  try {
    let servedModel = EXPRESSIVE_MODEL;
    let upstream = await synthesize(EXPRESSIVE_MODEL);
    if (!upstream.ok && upstream.status >= 400 && upstream.status < 500) {
      const detail = await upstream.text();
      console.warn(
        `ElevenLabs ${EXPRESSIVE_MODEL} request failed (${upstream.status}); retrying with ${FALLBACK_MODEL}:`,
        detail,
      );
      servedModel = FALLBACK_MODEL;
      upstream = await synthesize(FALLBACK_MODEL);
    }

    relayConcurrency(upstream, res, lastSeenConcurrency);

    if (!upstream.ok) {
      const err = await upstream.text();
      console.error("ElevenLabs error:", err);
      const retryAfter = upstream.headers.get("retry-after");
      if (retryAfter) res.setHeader("Retry-After", retryAfter);
      return res.status(upstream.status).json({ error: err });
    }

    const audio = await upstream.arrayBuffer();
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", audio.byteLength);
    // Which model actually rendered the line — the v2 fallback silently strips
    // all expressive markup, so surfacing this makes "why does it sound flat"
    // diagnosable from the browser's network tab.
    res.setHeader("X-TTS-Model", servedModel);
    return res.status(200).send(Buffer.from(audio));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("TTS error:", message);
    return res.status(500).json({ error: message });
  }
}
