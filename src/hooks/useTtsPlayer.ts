import { useCallback, useEffect, useRef } from "react";
import { apiFetch } from "../lib/api";

async function fetchTtsBlob(
  text: string,
  voiceId: string | undefined,
  signal?: AbortSignal
): Promise<Blob> {
  const res = await apiFetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voiceId }),
    signal,
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

/**
 * TTS playback with a one-slot prefetch cache. The rehearsal screen prefetches
 * the next AI line while the current step plays to keep auto-flow seamless.
 */
export function useTtsPlayer() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const prefetchRef = useRef<{ key: string; promise: Promise<Blob> } | null>(null);

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

  const cacheKey = (text: string, voiceId: string | undefined) =>
    `${voiceId ?? ""}|${text}`;

  const prefetch = useCallback((text: string, voiceId: string | undefined) => {
    const key = cacheKey(text, voiceId);
    if (prefetchRef.current?.key === key) return;
    const promise = fetchTtsBlob(text, voiceId);
    promise.catch(() => {
      // Failed prefetch: clear the slot so play() refetches fresh
      if (prefetchRef.current?.key === key) prefetchRef.current = null;
    });
    prefetchRef.current = { key, promise };
  }, []);

  /** Plays a line; resolves when audio finishes, rejects on fetch/play failure. */
  const play = useCallback(
    async (
      text: string,
      voiceId: string | undefined,
      opts?: { signal?: AbortSignal; onEnded?: () => void }
    ) => {
      stop();
      const key = cacheKey(text, voiceId);
      const cached =
        prefetchRef.current?.key === key ? prefetchRef.current.promise : null;
      const blob = await (cached ?? fetchTtsBlob(text, voiceId, opts?.signal));
      if (opts?.signal?.aborted) return;

      const url = URL.createObjectURL(blob);
      audioUrlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      if (opts?.onEnded) audio.onended = opts.onEnded;
      await audio.play();
    },
    [stop]
  );

  useEffect(() => stop, [stop]);

  return { play, prefetch, stop };
}
