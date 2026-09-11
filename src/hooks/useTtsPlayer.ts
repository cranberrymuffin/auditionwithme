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
  // Lazily created so most sessions (no self-tape recording) never pay for
  // an AudioContext. Once up, every played line is routed through it so a
  // self-tape recording can tap the line's audio directly instead of
  // picking it up acoustically off the mic.
  const audioContextRef = useRef<AudioContext | null>(null);
  const tapDestinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);

  const ensureTap = useCallback(() => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
      tapDestinationRef.current = audioContextRef.current.createMediaStreamDestination();
    }
    return { context: audioContextRef.current, destination: tapDestinationRef.current! };
  }, []);

  /** MediaStream carrying every line's audio, silent when nothing is playing. */
  const getTapStream = useCallback(() => ensureTap().destination.stream, [ensureTap]);

  const stop = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.onended = null;
      audioRef.current = null;
    }
    sourceNodeRef.current?.disconnect();
    sourceNodeRef.current = null;
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

      // Route through the shared tap so a self-tape recording (if any) picks
      // this line up directly, not acoustically off the mic. Still connected
      // to the context's own destination so normal speaker playback is unchanged.
      const { context, destination } = ensureTap();
      if (context.state === "suspended") await context.resume();
      const source = context.createMediaElementSource(audio);
      source.connect(context.destination);
      source.connect(destination);
      sourceNodeRef.current = source;

      await audio.play();
    },
    [stop, ensureTap]
  );

  /** Adjusts the rate of whatever is currently playing (and nothing else). */
  const setPlaybackRate = useCallback((speed: number) => {
    if (audioRef.current) audioRef.current.playbackRate = speed;
  }, []);

  useEffect(() => stop, [stop]);

  return { play, prefetch, stop, setPlaybackRate, getTapStream };
}
