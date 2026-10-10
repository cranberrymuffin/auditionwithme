import type { VercelRequest, VercelResponse } from "@vercel/node";

export type Voice = {
  id: string;
  name: string;
  gender: string;
  age: string;
  accent: string;
  description: string;
  language: string;
  locale: string;
  tone: string;
};

const VOICE_CACHE_TTL_MS = 15 * 60 * 1000;
const SYSTEM_BUSY_RETRY_DELAYS_MS = [250, 750];

let voiceCache: { voices: Voice[]; expiresAt: number } | null = null;
let voiceRequest: Promise<Voice[]> | null = null;

async function isSystemBusy(response: Response): Promise<boolean> {
  if (response.status !== 429) return false;
  try {
    const body = await response.clone().json() as {
      detail?: { code?: string; status?: string };
    };
    return body.detail?.code === "system_busy" || body.detail?.status === "system_busy";
  } catch {
    return false;
  }
}

/** Retry only ElevenLabs' transient system_busy response, never quota or concurrency 429s. */
export async function fetchElevenLabs(
  input: string,
  init: RequestInit,
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(input, init);
    if (
      attempt >= SYSTEM_BUSY_RETRY_DELAYS_MS.length ||
      !(await isSystemBusy(response))
    ) {
      return response;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, SYSTEM_BUSY_RETRY_DELAYS_MS[attempt]),
    );
  }
}

export async function fetchVoices(apiKey: string): Promise<Voice[]> {
  if (voiceCache && voiceCache.expiresAt > Date.now()) {
    return voiceCache.voices;
  }
  // Casting and the voice picker often load together. Share the same upstream
  // request rather than racing two ElevenLabs catalog calls on a cold start.
  if (voiceRequest) return voiceRequest;

  voiceRequest = (async () => {
    const upstream = await fetchElevenLabs("https://api.elevenlabs.io/v2/voices?page_size=100", {
      headers: { "xi-api-key": apiKey },
    });

    if (!upstream.ok) {
      throw new Error(`ElevenLabs voices fetch failed: ${await upstream.text()}`);
    }

    type RawVoice = {
      voice_id: string;
      name: string;
      labels?: Record<string, string | undefined>;
    };
    const data = (await upstream.json()) as { voices?: RawVoice[] };
    const voices = (data.voices ?? []).map((v) => ({
      id: v.voice_id,
      name: v.name,
      gender: v.labels?.gender ?? "neutral",
      age: v.labels?.age ?? "",
      accent: v.labels?.accent ?? "",
      description: v.labels?.description ?? v.labels?.use_case ?? "",
      language: v.labels?.language ?? "en",
      locale: v.labels?.locale ?? "",
      tone: v.labels?.descriptive ?? "",
    }));
    voiceCache = { voices, expiresAt: Date.now() + VOICE_CACHE_TTL_MS };
    return voices;
  })();

  try {
    return await voiceRequest;
  } finally {
    // Do not cache failures; the next request should retry ElevenLabs.
    voiceRequest = null;
  }
}

// Best-effort guard for the ElevenLabs Starter plan's 3 concurrent slots,
// which every user shares through this one server key — text-to-speech
// (api/tts.ts) and speech-to-speech (api/sts.ts) alike. Pre-generation
// requests (X-TTS-Purpose: pregen, from useReaderAudioPregen.ts) are held —
// 429 + Retry-After without calling ElevenLabs — whenever the last reading
// showed only one slot left, so that slot stays free for someone's live
// playback. Live requests are never held. This is module state, so it's only
// as good as one warm serverless instance's view: other instances may
// disagree. ElevenLabs' own 429 + Retry-After (which the client honors) stays
// the real backstop. Follow-up if it proves too loose: a durable counter via
// the api_rate_limits table / check_rate_limit function.
export type ConcurrencyReading = { current: number; max: number; updatedAt: number };
// A reading this old says little about who's generating right now.
const CONCURRENCY_READING_TTL_MS = 15_000;
const PREGEN_HOLD_RETRY_AFTER_S = 2;

export function shouldHoldPregen(reading: ConcurrencyReading, now: number): boolean {
  if (now - reading.updatedAt > CONCURRENCY_READING_TTL_MS) return false;
  return reading.current >= reading.max - 1;
}

/** Answers a pre-generation request with a hold (429) instead of calling
 * ElevenLabs, if `reading` says the account is near its limit. True when it
 * did, and the handler should stop there. */
export function holdPregenIfBusy(
  req: VercelRequest,
  res: VercelResponse,
  reading: ConcurrencyReading,
): boolean {
  if (req.headers["x-tts-purpose"] !== "pregen" || !shouldHoldPregen(reading, Date.now())) {
    return false;
  }
  res.setHeader("Retry-After", String(PREGEN_HOLD_RETRY_AFTER_S));
  res.setHeader("X-TTS-Pregen-Hold", "true");
  res.setHeader("X-TTS-Current-Concurrent", String(reading.current));
  res.setHeader("X-TTS-Max-Concurrent", String(reading.max));
  res.status(429).json({
    error: "Pre-generation paused: voice service is near its limit",
  });
  return true;
}

/** Surfaces ElevenLabs' concurrency headers on every response (not just
 * 429s) so useTtsPlayer.ts's retry logic can respect real guidance from
 * ElevenLabs instead of guessing at a backoff, and so utilization is visible
 * in the network tab before a 429 actually happens — see
 * https://elevenlabs.io/blog/ai-rate-limiting-for-voice, whose core point is
 * that the limit that matters is concurrency, not request count. Every
 * response (live or pregen, ok or not) refreshes `reading`, the hold guard. */
export function relayConcurrency(
  upstream: Response,
  res: VercelResponse,
  reading: ConcurrencyReading,
): void {
  const currentConcurrent = upstream.headers.get("current-concurrent-requests");
  const maxConcurrent = upstream.headers.get("maximum-concurrent-requests");
  if (currentConcurrent) res.setHeader("X-TTS-Current-Concurrent", currentConcurrent);
  if (maxConcurrent) res.setHeader("X-TTS-Max-Concurrent", maxConcurrent);
  if (
    currentConcurrent &&
    maxConcurrent &&
    Number.isFinite(Number(currentConcurrent)) &&
    Number.isFinite(Number(maxConcurrent))
  ) {
    reading.current = Number(currentConcurrent);
    reading.max = Number(maxConcurrent);
    reading.updatedAt = Date.now();
  }
  if (
    currentConcurrent &&
    maxConcurrent &&
    Number(currentConcurrent) >= Number(maxConcurrent) - 1
  ) {
    console.warn(
      `ElevenLabs concurrency near limit: ${currentConcurrent}/${maxConcurrent}`,
    );
  }
}
