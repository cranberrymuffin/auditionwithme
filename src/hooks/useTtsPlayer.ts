import { useCallback, useEffect, useRef } from "react";
import { apiFetch } from "../lib/api";

/** One line of dialogue plus the context the TTS model uses for prosody. */
export type TtsLine = {
  text: string;
  voiceId?: string;
  /** The line spoken before this one — conditions the read as a reply. */
  previousText?: string;
  /** The line spoken after this one. */
  nextText?: string;
  /** Eleven v3 audio tag, e.g. "angry" or "whispers". */
  deliveryTag?: string;
  /** AI-director markup of `text`: inline v3 audio tags + pacing punctuation. */
  performance?: string;
};

export type TtsIntensity = "subtle" | "natural" | "dramatic";

export type TtsPlayOptions = {
  intensity?: TtsIntensity;
  /** Playback rate applied client-side (pitch-preserving). */
  speed?: number;
  /** Skip the cache and generate a new take. */
  fresh?: boolean;
  signal?: AbortSignal;
  onEnded?: () => void;
};

const MAX_CACHE_ENTRIES = 60;

// Session-wide audio cache: replaying a line (or backing out and returning)
// doesn't re-bill ElevenLabs, and the scene partner gives the same read on
// replay — important now that v3 varies noticeably between takes.
const blobCache = new Map<string, Promise<Blob>>();

const cacheKey = (line: TtsLine, intensity: TtsIntensity) =>
  JSON.stringify([
    line.voiceId ?? "",
    line.text,
    line.deliveryTag ?? "",
    line.performance ?? "",
    line.previousText ?? "",
    line.nextText ?? "",
    intensity,
  ]);

async function fetchTtsBlob(line: TtsLine, intensity: TtsIntensity): Promise<Blob> {
  const res = await apiFetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: line.text,
      voiceId: line.voiceId,
      previousText: line.previousText,
      nextText: line.nextText,
      deliveryTag: line.deliveryTag,
      performance: line.performance,
      intensity,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    let message = "Voice playback failed";
    try {
      const parsed = JSON.parse(body) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      if (body) message = body;
    }
    throw new Error(message);
  }
  return res.blob();
}

function getBlob(line: TtsLine, intensity: TtsIntensity, fresh = false): Promise<Blob> {
  const key = cacheKey(line, intensity);
  if (fresh) blobCache.delete(key);
  const cached = blobCache.get(key);
  if (cached) return cached;
  const promise = fetchTtsBlob(line, intensity);
  promise.catch(() => {
    // Failed fetch: clear the slot so the next attempt refetches fresh
    if (blobCache.get(key) === promise) blobCache.delete(key);
  });
  blobCache.set(key, promise);
  if (blobCache.size > MAX_CACHE_ENTRIES) {
    const oldest = blobCache.keys().next().value;
    if (oldest !== undefined) blobCache.delete(oldest);
  }
  return promise;
}

/**
 * TTS playback backed by the session-wide audio cache. The rehearsal screen
 * prefetches the next AI line while the current step plays to keep auto-flow
 * seamless.
 */
export function useTtsPlayer() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);

  const stop = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.onended = null;
      audioRef.current = null;
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
  }, []);

  const prefetch = useCallback((line: TtsLine, intensity: TtsIntensity = "natural") => {
    void getBlob(line, intensity);
  }, []);

  /** Plays a line; resolves when audio finishes, rejects on fetch/play failure. */
  const play = useCallback(
    async (line: TtsLine, opts?: TtsPlayOptions) => {
      stop();
      const blob = await getBlob(line, opts?.intensity ?? "natural", opts?.fresh);
      if (opts?.signal?.aborted) return;

      const url = URL.createObjectURL(blob);
      audioUrlRef.current = url;
      const audio = new Audio(url);
      audio.playbackRate = opts?.speed ?? 1;
      audioRef.current = audio;
      if (opts?.onEnded) audio.onended = opts.onEnded;
      await audio.play();
    },
    [stop]
  );

  /** Adjusts the rate of whatever is currently playing (and nothing else). */
  const setPlaybackRate = useCallback((speed: number) => {
    if (audioRef.current) audioRef.current.playbackRate = speed;
  }, []);

  useEffect(() => stop, [stop]);

  return { play, prefetch, stop, setPlaybackRate };
}
