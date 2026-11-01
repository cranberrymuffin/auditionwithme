import { apiFetch } from "./api";
import { clampCharacterVolume } from "./characterVolume";
import { cacheKey, type TtsIntensity, type TtsLine } from "./ttsCacheKey";
import { loadReaderAudio, saveReaderAudio } from "./readerAudioStore";
import { loadCoachTakeBlob } from "./coachTakeStore";
import { toBase64, toPcm16kMono } from "./pcm";

// TTS audio for the scene partner: fetching (with retries and rate-limit
// backoff), the session-wide in-memory cache, on-device storage, and the
// browser-voice fallback. Shared by useTtsPlayer's web and iOS-app players,
// which differ only in how a fetched line is played.

export type TtsPlayOptions = {
  intensity?: TtsIntensity;
  /** Playback rate applied client-side (pitch-preserving). */
  speed?: number;
  /** This speaker's level (lib/characterVolume.ts); default unity. */
  volume?: number;
  signal?: AbortSignal;
  onEnded?: () => void;
  /** Fired on the audio element's 'playing' event — when the line actually
   * starts producing sound, not when play() was called. Not fired if the
   * line falls back to the browser's own voice. */
  onPlaying?: () => void;
  /** Fired with a human-readable reason if the AI voice couldn't be
   * reached/played and playback fell back to the browser's own voice, so
   * callers can surface *why* (e.g. in the "Cue playback failed" status)
   * even though the line still gets read. */
  onFallback?: (reason: string) => void;
};

const MAX_CACHE_ENTRIES = 60;

// One silent sample — just enough for a real HTMLMediaElement to actually
// play. WebKit's autoplay gate isn't only about the AudioContext: it also
// tracks, page-wide, whether *some* media element has ever audibly played as
// a direct result of a user gesture. Every TTS line is created and played
// from inside an async fetch chain, never synchronously inside the Start
// click, so none of them can ever satisfy that flag themselves — playing
// this synchronously in the click handler is what actually does.
export const SILENT_AUDIO_DATA_URI =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

/** Turns whatever a fetch/DOM API threw into a short, displayable reason. */
export function describeError(err: unknown, fallback: string): string {
  if (err instanceof DOMException) return `${fallback} (${err.name})`;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

// Session-wide audio cache: replaying a line (or backing out and returning)
// doesn't re-bill ElevenLabs, and the scene partner gives the same read on
// replay — important now that v3 varies noticeably between takes.
const blobCache = new Map<string, Promise<Blob>>();

// Pre-generation requests (useReaderAudioPregen.ts) still in flight. A line
// played while its pre-generation is pending waits on that request rather
// than paying for a second one — but if it fails (a 429 hold, say), playback
// fetches the line itself instead of falling back to the browser voice.
const pregenInFlight = new WeakSet<Promise<Blob>>();

function rememberBlob(key: string, promise: Promise<Blob>) {
  blobCache.set(key, promise);
  if (blobCache.size > MAX_CACHE_ENTRIES) {
    const oldest = blobCache.keys().next().value;
    if (oldest !== undefined) blobCache.delete(oldest);
  }
}

/** Warms the in-memory cache with audio already generated (pre-generation,
 * or a hit in the on-device store), so playback finds it instantly. */
export function seedTtsCache(key: string, blob: Blob): void {
  if (!blobCache.has(key)) rememberBlob(key, Promise.resolve(blob));
}

/** Whatever the in-memory cache holds for `key` — settled or still pending. */
export function peekTtsCache(key: string): Promise<Blob> | undefined {
  return blobCache.get(key);
}

/** Registers a pre-generation request for `key` so playback reuses it
 * instead of fetching the same line twice. False (and nothing registered)
 * if something else already holds the key. */
export function trackPregenFetch(key: string, promise: Promise<Blob>): boolean {
  if (blobCache.has(key)) return false;
  pregenInFlight.add(promise);
  rememberBlob(key, promise);
  promise.then(
    () => pregenInFlight.delete(promise),
    () => {
      pregenInFlight.delete(promise);
      if (blobCache.get(key) === promise) blobCache.delete(key);
    },
  );
  return true;
}

// Mobile networks (cellular handoffs, backgrounding, spotty wifi) can leave a
// fetch neither resolving nor rejecting for minutes. Without a timeout that
// hang propagates all the way up through play() — no onEnded, no onFallback,
// no error — so the cue just never gets read and the UI stays stuck on
// "is speaking…" with no way to tell what happened. Aborting after 15s turns
// that silent hang into an ordinary failure the retry/fallback logic already handles.
const FETCH_TIMEOUT_MS = 15_000;
// Speech-to-speech works through the whole take (and cleans its background
// noise) before answering, so a coached line gets longer.
const COACHED_FETCH_TIMEOUT_MS = 30_000;

/** Extra request options for callers other than playback — today only
 * pre-generation, which tags its requests and watches account concurrency. */
export type TtsFetchOptions = {
  /** Added to the /api/tts request, e.g. X-TTS-Purpose: pregen. */
  headers?: Record<string, string>;
  /** Called with every response (including errors) before it's consumed. */
  onResponse?: (res: Response) => void;
  /** Retry 429s here (default). False rethrows the TtsRateLimitError at
   * once, for callers that schedule their own wait. */
  retryRateLimit?: boolean;
  /** Checked only between attempts (useReaderAudioPregen.ts, on cleanup): an
   * aborted signal stops the backoff wait early and skips the next retry,
   * so a line can stop waiting on a hold/backoff promptly once pre-generation
   * is torn down. It's never passed into the request itself — a fetch already
   * sent to the server keeps running, since ElevenLabs has already started
   * (and billed) the generation by the time a response comes back. */
  signal?: AbortSignal;
};

/** The route and body for `line`: text-to-speech, or — for a coached line —
 * its on-device recording, sent for speech-to-speech. */
async function lineRequest(
  line: TtsLine,
  intensity: TtsIntensity,
): Promise<{ path: string; body: string; timeoutMs: number }> {
  if (line.coachTakeId) {
    const take = await loadCoachTakeBlob(line.coachTakeId);
    if (!take) throw new Error("That coached line’s recording isn’t on this device any more");
    return {
      path: "/api/sts",
      body: JSON.stringify({
        voiceId: line.voiceId,
        audio: toBase64(await toPcm16kMono(take)),
      }),
      timeoutMs: COACHED_FETCH_TIMEOUT_MS,
    };
  }
  return {
    path: "/api/tts",
    body: JSON.stringify({
      text: line.text,
      voiceId: line.voiceId,
      previousText: line.previousText,
      nextText: line.nextText,
      deliveryTag: line.deliveryTag,
      performance: line.performance,
      emotion: line.emotion,
      languageCode: line.languageCode,
      intensity,
    }),
    timeoutMs: FETCH_TIMEOUT_MS,
  };
}

async function fetchTtsBlob(
  line: TtsLine,
  intensity: TtsIntensity,
  opts?: TtsFetchOptions,
): Promise<Blob> {
  const { path, body, timeoutMs } = await lineRequest(line, intensity);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await apiFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...opts?.headers },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) throw new Error("Voice playback timed out");
    throw err;
  } finally {
    clearTimeout(timer);
  }
  opts?.onResponse?.(res);
  if (!res.ok) {
    const body = await res.text();
    let message = "Voice playback failed";
    try {
      const parsed = JSON.parse(body) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      if (body) message = body;
    }
    if (res.status === 429) {
      const retryAfterHeader = res.headers.get("Retry-After");
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
      throw new TtsRateLimitError(
        message,
        Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : null,
      );
    }
    throw new Error(message);
  }
  return res.blob();
}

/** A 429 from api/tts.ts, carrying ElevenLabs' own Retry-After guidance (in
 * ms) when it sent one, so the retry below can wait exactly as long as it's
 * told instead of guessing. */
export class TtsRateLimitError extends Error {
  retryAfterMs: number | null;
  constructor(message: string, retryAfterMs: number | null) {
    super(message);
    this.name = "TtsRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

// ElevenLabs already retries its own transient system_busy responses
// server-side; these extra client-side attempts cover everything else that
// can make one round trip fail transiently — a dropped connection, our own
// function cold-starting, a one-off 5xx or 429 — before we give up and fall
// back to the browser's own voice.
const MAX_RETRIES = 2;
const BASE_RETRY_DELAY_MS = 400;
const MAX_RETRY_DELAY_MS = 4000;
// A real Retry-After is trusted over our own guess, but still capped: a
// rehearsal line stuck waiting on a long server-requested delay is worse UX
// than falling back to the browser voice a little early.
const RETRY_AFTER_CAP_MS = 6000;

// Exponential backoff with jitter (per
// https://elevenlabs.io/blog/ai-rate-limiting-for-voice) rather than a fixed
// delay, so repeated failures back off instead of retrying in lockstep with
// whatever caused the first one.
function backoffDelayMs(attempt: number): number {
  const exp = Math.min(BASE_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
  return Math.round(exp * (0.7 + Math.random() * 0.6)); // ±30% jitter
}

/** Resolves after `ms`, or as soon as `signal` aborts — whichever comes
 * first. Used only to cut short the WAIT between attempts below; the fetch
 * already under way when a signal aborts is untouched. */
function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export async function fetchTtsBlobWithRetry(
  line: TtsLine,
  intensity: TtsIntensity,
  opts?: TtsFetchOptions,
): Promise<Blob> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchTtsBlob(line, intensity, opts);
    } catch (err) {
      if (attempt >= MAX_RETRIES) throw err;
      if (err instanceof TtsRateLimitError && opts?.retryRateLimit === false) throw err;
      // Already torn down: don't sit through a full backoff just to make an
      // attempt nobody's waiting on any more.
      if (opts?.signal?.aborted) throw err;
      const delay =
        err instanceof TtsRateLimitError && err.retryAfterMs !== null
          ? Math.min(err.retryAfterMs, RETRY_AFTER_CAP_MS)
          : backoffDelayMs(attempt);
      await sleepUnlessAborted(delay, opts?.signal);
      if (opts?.signal?.aborted) throw err;
    }
  }
}

// The on-device store normally answers in a few ms. If it doesn't (another
// tab blocking the v2 upgrade, a wedged IndexedDB on iOS), stop waiting and
// fetch live — the actor is waiting on this line.
const STORED_AUDIO_TIMEOUT_MS = 1000;

async function loadStoredAudio(key: string): Promise<Blob | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), STORED_AUDIO_TIMEOUT_MS);
  });
  try {
    return await Promise.race([loadReaderAudio(key).catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Per-player context for a lookup: where live-fetched audio is stored, and
 * who to tell when a line had to come from (or wait on) the network. */
type LookupContext = {
  scriptId?: string | null;
  onLiveFetch?: () => void;
  /** Playback is blocked on this lookup (play), not just warming (prefetch). */
  waiting?: boolean;
};

/**
 * Three tiers: the in-memory cache, then the on-device reader-audio store
 * (pre-generated or previously fetched lines, surviving reloads), then a
 * live ElevenLabs fetch — whose result is stored on-device too when the
 * player knows the script, so the next take or a reload doesn't pay again.
 */
export function getBlob(
  line: TtsLine,
  intensity: TtsIntensity,
  ctx: LookupContext = {},
): Promise<Blob> {
  const key = cacheKey(line, intensity);
  const cached = blobCache.get(key);
  if (cached && pregenInFlight.has(cached)) {
    // Pre-generation hasn't finished this line: playback waiting on it is a
    // live fetch as far as the actor's concerned. trackPregenFetch's own
    // rejection handler (registered first) has already cleared the slot by
    // the time the retry below runs; it isn't counted again.
    if (ctx.waiting) ctx.onLiveFetch?.();
    return cached.catch(() =>
      getBlob(line, intensity, { ...ctx, onLiveFetch: ctx.waiting ? undefined : ctx.onLiveFetch }),
    );
  }
  if (cached) return cached;
  const promise = (async () => {
    const stored = await loadStoredAudio(key);
    if (stored) return stored;
    ctx.onLiveFetch?.();
    const blob = await fetchTtsBlobWithRetry(line, intensity);
    if (ctx.scriptId) {
      void saveReaderAudio(key, ctx.scriptId, blob).catch((err) =>
        console.warn("Couldn't store reader audio on-device:", err),
      );
    }
    return blob;
  })();
  promise.catch(() => {
    // Failed fetch: clear the slot so the next attempt refetches fresh
    if (blobCache.get(key) === promise) blobCache.delete(key);
  });
  rememberBlob(key, promise);
  return promise;
}

/**
 * Last resort when ElevenLabs is unreachable even after retries: the actor
 * still needs to hear the cue, so read it with the browser's own voice
 * instead of leaving the line silent. Resolves once speech starts (mirroring
 * play()'s contract) and fires onEnded when the utterance finishes.
 */
export function speakWithBrowserVoice(
  text: string,
  opts?: TtsPlayOptions,
): Promise<void> {
  return new Promise((resolve) => {
    if (!text.trim() || !("speechSynthesis" in window)) {
      opts?.onEnded?.();
      resolve();
      return;
    }
    // Some mobile browsers (Android Chrome after the tab was backgrounded,
    // in particular) silently drop an utterance — neither onstart nor
    // onerror ever fires. Without this, that hangs the rehearsal forever on
    // a line nobody ever reads; treating it as "finished" after a timeout at
    // least lets the scene move on.
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts?.onEnded?.();
      resolve();
    };
    const timer = setTimeout(settle, FETCH_TIMEOUT_MS);
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = opts?.speed ?? 1;
    // Speech synthesis can't go above full volume, only below it.
    utterance.volume = Math.min(clampCharacterVolume(opts?.volume), 1);
    utterance.onstart = () => {
      clearTimeout(timer);
      resolve();
    };
    utterance.onend = settle;
    utterance.onerror = settle;
    window.speechSynthesis.speak(utterance);
  });
}

