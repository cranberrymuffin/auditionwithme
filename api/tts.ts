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

// Eleven v4 is the expressive acting model: it takes inline audio tags like
// "[angry]". Eleven v3 is the fallback when v4 can't serve a request (a voice
// it doesn't support, a validation error): it takes the same tags and the
// same stability rules, so a line that falls back keeps its performance and
// only loses v4's extra movement. Nothing falls back past v3 — the player's
// browser-TTS fallback (useTtsPlayer.ts) covers a line neither can render —
// and the old multilingual_v2 fallback, which read every tag out loud and
// silently flattened the line, is gone.
//
// v4 replaced v3 after the emotiveness benchmark (benchmarks/voice/emotion.ts,
// October 2026): beta testers heard v3 as robotic, and v3 turned out to barely
// respond to the director's tags or to stability — lines it tagged moved no
// more than lines it left alone, and stability 0.2–0.5 made no measurable
// difference. v4 adds about half a semitone of pitch movement on most lines
// and was preferred for naturalness on 59% of blind pairs (fit on 57%).
// Unlike v3, v4 accepts previous_text/next_text: see LINE_CONTEXT_CHARS.
const EXPRESSIVE_MODEL = "eleven_v4";
const FALLBACK_MODEL = "eleven_v3";

// Account-level refusals: a bad key or exhausted quota (401/402) and a full
// concurrency slot or rate limit (429). v3 runs on the same account, so
// retrying there would only spend another request — and under a 429 add load
// at the worst moment, or render the line on v3 and cache it as v4. These go
// straight back to the client, which honors Retry-After.
const ACCOUNT_LEVEL_STATUSES = new Set([401, 402, 429]);

/** Whether a failed v4 request is worth retrying on the v3 fallback. */
export function shouldFallBack(status: number): boolean {
  return status >= 400 && status < 500 && !ACCOUNT_LEVEL_STATUSES.has(status);
}

// The client still sends `intensity` (pinned to "natural" and kept in its
// cache key); it's ignored here. A global intensity knob made every line
// louder at once, which beta testers heard as over-acting — emotion comes
// from the director's per-line audio tags plus each character's own Emotion
// setting.

// The neighbouring lines go to v4 as previous_text/next_text, which ElevenLabs
// recommends for prosody that flows across separate requests: the line reads
// as a reply to what was just said, not a cold open. Clipped to the words
// nearest the line — that's the context that shapes its delivery, and it
// bounds the request whatever ElevenLabs counts. Not sent to v3, which
// rejects both (unsupported_model).
const LINE_CONTEXT_CHARS = 300;

/** A neighbouring line made safe to send: trimmed, clipped to the end nearest
 * this line (`keep: "end"` for the line before, "start" for the line after),
 * or null when there's nothing usable. */
export function lineContext(value: unknown, keep: "start" | "end"): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  if (text.length <= LINE_CONTEXT_CHARS) return text;
  return keep === "end" ? text.slice(-LINE_CONTEXT_CHARS) : text.slice(0, LINE_CONTEXT_CHARS);
}

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

/** The request's language as an ISO 639 code, or null (missing, junk). */
export function parseLanguageCode(languageCode: unknown): string | null {
  return typeof languageCode === "string" && /^[a-z]{2,3}$/i.test(languageCode.trim())
    ? languageCode.trim().toLowerCase()
    : null;
}

const clampStability = (stability: number) =>
  Math.round(Math.min(Math.max(stability, 0), 1) * 100) / 100;

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

// Ordinary lines read at 0.3. The value predates v4 (it was the v3 setting
// between Natural, 0.5, which sounded flat, and Creative, 0, which over-acted)
// and was kept on v4 because the benchmark found stability makes little
// difference there either: 0.45 scored the same as 0.3 for flatness and
// over-acting. v4 follows the director's tags much more strongly than v3,
// so it can over-play a tagged, high-intensity line; that's a prompt matter,
// not a stability one. Creative is kept only for the script's own
// big-delivery parentheticals, whatever the character's Emotion setting:
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
    deliveryTag,
    performance,
    emotion: rawEmotion,
    languageCode: rawLanguageCode,
    previousText: rawPreviousText,
    nextText: rawNextText,
  } = (req.body ?? {}) as {
      text?: string;
      voiceId?: string;
      deliveryTag?: string;
      /** AI-director markup of `text`: inline v3 audio tags + pacing punctuation. */
      performance?: string;
      /** The character's Emotion setting, -1 … 1 (missing = natural). */
      emotion?: unknown;
      /** The script's language (ISO 639-1); sent only off English. */
      languageCode?: unknown;
      /** The lines spoken just before and after this one. */
      previousText?: unknown;
      nextText?: unknown;
    };
  const emotion = parseEmotion(rawEmotion);
  const languageCode = parseLanguageCode(rawLanguageCode);
  const previousText = lineContext(rawPreviousText, "end");
  const nextText = lineContext(rawNextText, "start");
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
  // `tag` is the explicit deliveryTag (script parenthetical) only — director
  // markup never makes a line "big".
  const stability = v3Stability(tag != null && BIG_DELIVERY_TAGS.has(tag), emotion);

  // language_code and the line context go on the v4 request only. The
  // fallback exists for requests v4 rejected, and an unsupported language
  // code is one way to get there; v3 rejects the context outright. So v3
  // gets the plain request.
  const synthesize = (modelId: string, isExpressive: boolean) =>
    fetchElevenLabs(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId || DEFAULT_VOICE_ID)}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
        },
        // Both models read the tags; only v4 gets the language and context.
        body: JSON.stringify({
          text: expressiveText,
          model_id: modelId,
          voice_settings: { stability },
          ...(isExpressive && languageCode ? { language_code: languageCode } : {}),
          ...(isExpressive && previousText ? { previous_text: previousText } : {}),
          ...(isExpressive && nextText ? { next_text: nextText } : {}),
        }),
      },
    );

  try {
    let servedModel = EXPRESSIVE_MODEL;
    let upstream = await synthesize(EXPRESSIVE_MODEL, true);
    if (!upstream.ok && shouldFallBack(upstream.status)) {
      const detail = await upstream.text();
      console.warn(
        `ElevenLabs ${EXPRESSIVE_MODEL} request failed (${upstream.status}); retrying with ${FALLBACK_MODEL}:`,
        detail,
      );
      servedModel = FALLBACK_MODEL;
      upstream = await synthesize(FALLBACK_MODEL, false);
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
    // Which model actually rendered the line, so a fallback to v3 is
    // diagnosable from the browser's network tab.
    res.setHeader("X-TTS-Model", servedModel);
    return res.status(200).send(Buffer.from(audio));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("TTS error:", message);
    return res.status(500).json({ error: message });
  }
}
