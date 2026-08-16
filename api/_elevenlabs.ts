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
