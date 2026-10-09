import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAuthRateLimited } from "./_entitlement.js";
import { sanitizePerformance } from "./_direction.js";
import { fetchElevenLabs } from "./_elevenlabs.js";

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
// testers heard as over-acting. Emotion now comes from per-line audio tags.
const V2_SETTINGS = { stability: 0.45, style: 0.35 };

// Cap on how much surrounding dialogue is sent as prosody context — roughly
// the last/next five or six lines, enough to carry the scene's emotional arc.
const CONTEXT_CHAR_LIMIT = 1800;

// Script parentheticals that genuinely call for a big, uncontained read.
// The AI director can't produce these (they're kept out of its vocabulary in
// api/casting.ts) — only an explicit "(shouting)"-style direction in the
// script itself, mapped by src/lib/delivery.ts, can.
export const BIG_DELIVERY_TAGS = new Set(["shouts", "screams", "crying", "terrified", "panicked"]);

// v3 stability only accepts the discrete values 1 (Robust), 0.5 (Natural),
// and 0 (Creative). Natural still follows audio tags — per ElevenLabs' v3
// guidance, emotion should come from scene-aware tags, not from loosening
// stability — while Creative exaggerated every tagged line into something
// beta testers called "over the top" for an audition reader. Creative is
// kept only for the script's own big-delivery parentheticals.
export function v3Stability(bigDelivery: boolean): number {
  return bigDelivery ? 0 : 0.5;
}

// Best-effort guard for the ElevenLabs Starter plan's 3 concurrent TTS slots,
// which every user shares through this one server key. Pre-generation
// requests (X-TTS-Purpose: pregen, from useReaderAudioPregen.ts) are held —
// 429 + Retry-After without calling ElevenLabs — whenever the last reading
// showed only one slot left, so that slot stays free for someone's live
// playback. Live requests are never held. This is module state, so it's only
// as good as one warm serverless instance's view: other instances may
// disagree. ElevenLabs' own 429 + Retry-After (which the client honors) stays
// the real backstop. Follow-up if it proves too loose: a durable counter via
// the api_rate_limits table / check_rate_limit function.
const lastSeenConcurrency = { current: 0, max: 3, updatedAt: 0 };
// A reading this old says little about who's generating right now.
const CONCURRENCY_READING_TTL_MS = 15_000;
const PREGEN_HOLD_RETRY_AFTER_S = 2;

export function shouldHoldPregen(
  reading: { current: number; max: number; updatedAt: number },
  now: number,
): boolean {
  if (now - reading.updatedAt > CONCURRENCY_READING_TTL_MS) return false;
  return reading.current >= reading.max - 1;
}

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

  const { text, voiceId, previousText, nextText, deliveryTag, performance } =
    (req.body ?? {}) as {
      text?: string;
      voiceId?: string;
      previousText?: string;
      nextText?: string;
      deliveryTag?: string;
      /** AI-director markup of `text`: inline v3 audio tags + pacing punctuation. */
      performance?: string;
    };
  if (!text?.trim()) {
    return res.status(400).json({ error: "No text provided" });
  }

  const purpose = req.headers["x-tts-purpose"];
  if (purpose === "pregen" && shouldHoldPregen(lastSeenConcurrency, Date.now())) {
    res.setHeader("Retry-After", String(PREGEN_HOLD_RETRY_AFTER_S));
    res.setHeader("X-TTS-Pregen-Hold", "true");
    res.setHeader("X-TTS-Current-Concurrent", String(lastSeenConcurrency.current));
    res.setHeader("X-TTS-Max-Concurrent", String(lastSeenConcurrency.max));
    return res.status(429).json({ error: "Pre-generation paused: voice service is near its limit" });
  }

  const tag =
    typeof deliveryTag === "string" && /^[a-z][a-z ]{0,23}$/i.test(deliveryTag.trim())
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
                voice_settings: { stability: v3Stability(tag != null && BIG_DELIVERY_TAGS.has(tag)) },
              }
            : {
                text,
                model_id: modelId,
                voice_settings: {
                  ...V2_SETTINGS,
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

    // Surfaced on every response (not just 429s) so useTtsPlayer.ts's retry
    // logic can respect real guidance from ElevenLabs instead of guessing at
    // a backoff, and so utilization is visible in the network tab before a
    // 429 actually happens — see
    // https://elevenlabs.io/blog/ai-rate-limiting-for-voice, whose core point
    // is that the limit that matters is concurrency, not request count.
    const currentConcurrent = upstream.headers.get("current-concurrent-requests");
    const maxConcurrent = upstream.headers.get("maximum-concurrent-requests");
    if (currentConcurrent) res.setHeader("X-TTS-Current-Concurrent", currentConcurrent);
    if (maxConcurrent) res.setHeader("X-TTS-Max-Concurrent", maxConcurrent);
    // Every response (live or pregen, ok or not) refreshes the hold guard.
    if (
      currentConcurrent &&
      maxConcurrent &&
      Number.isFinite(Number(currentConcurrent)) &&
      Number.isFinite(Number(maxConcurrent))
    ) {
      lastSeenConcurrency.current = Number(currentConcurrent);
      lastSeenConcurrency.max = Number(maxConcurrent);
      lastSeenConcurrency.updatedAt = Date.now();
    }
    if (currentConcurrent && maxConcurrent && Number(currentConcurrent) >= Number(maxConcurrent) - 1) {
      console.warn(
        `ElevenLabs concurrency near limit: ${currentConcurrent}/${maxConcurrent}`,
      );
    }

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
