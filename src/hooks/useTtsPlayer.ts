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

// ElevenLabs already retries its own transient system_busy responses
// server-side; these extra client-side attempts cover everything else that
// can make one round trip fail transiently — a dropped connection, our own
// function cold-starting, a one-off 5xx — before we give up and fall back
// to the browser's own voice.
const FETCH_RETRY_DELAYS_MS = [400, 1200];

async function fetchTtsBlobWithRetry(line: TtsLine, intensity: TtsIntensity): Promise<Blob> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchTtsBlob(line, intensity);
    } catch (err) {
      if (attempt >= FETCH_RETRY_DELAYS_MS.length) throw err;
      await new Promise((resolve) => setTimeout(resolve, FETCH_RETRY_DELAYS_MS[attempt]));
    }
  }
}

function getBlob(line: TtsLine, intensity: TtsIntensity, fresh = false): Promise<Blob> {
  const key = cacheKey(line, intensity);
  if (fresh) blobCache.delete(key);
  const cached = blobCache.get(key);
  if (cached) return cached;
  const promise = fetchTtsBlobWithRetry(line, intensity);
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
 * Last resort when ElevenLabs is unreachable even after retries: the actor
 * still needs to hear the cue, so read it with the browser's own voice
 * instead of leaving the line silent. Resolves once speech starts (mirroring
 * play()'s contract) and fires onEnded when the utterance finishes.
 */
function speakWithBrowserVoice(text: string, opts?: TtsPlayOptions): Promise<void> {
  return new Promise((resolve) => {
    if (!text.trim() || !("speechSynthesis" in window)) {
      opts?.onEnded?.();
      resolve();
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = opts?.speed ?? 1;
    utterance.onstart = () => resolve();
    utterance.onend = () => opts?.onEnded?.();
    utterance.onerror = () => {
      opts?.onEnded?.();
      resolve();
    };
    window.speechSynthesis.speak(utterance);
  });
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

  // Autoplay policies (Safari in particular) require the AudioContext to be
  // resumed synchronously inside a user gesture. The rehearsal's first cue
  // plays seconds after the Start button is clicked (once the countdown
  // ends), well outside that gesture — so without this, the very first line
  // can silently fail to play. Call this directly from the click handler.
  // Resume unconditionally, not just when state is "suspended": Safari's
  // camera/mic permission prompt (which lands right after this call) can
  // knock the context into its own "interrupted" state, which resume() also
  // clears but the "suspended" check doesn't catch — leaving the first cue
  // connected to a silent context that never throws, so it just plays with
  // no sound instead of erroring or falling back.
  const unlock = useCallback(() => {
    const { context } = ensureTap();
    void context.resume();
  }, [ensureTap]);

  const stop = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.onended = null;
      audioRef.current = null;
    }
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
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

  /**
   * Plays a line; resolves once playback starts and fires onEnded when it
   * finishes. Falls back to the browser's own voice — rather than rejecting
   * — if ElevenLabs can't be reached or the audio element won't play (e.g.
   * an autoplay block), so a cue is (almost) never left unread.
   */
  const play = useCallback(
    async (line: TtsLine, opts?: TtsPlayOptions) => {
      stop();
      let blob: Blob;
      try {
        blob = await getBlob(line, opts?.intensity ?? "natural", opts?.fresh);
      } catch {
        if (opts?.signal?.aborted) return;
        return speakWithBrowserVoice(line.text, opts);
      }
      if (opts?.signal?.aborted) return;

      const url = URL.createObjectURL(blob);
      audioUrlRef.current = url;
      const audio = new Audio(url);
      audio.playbackRate = opts?.speed ?? 1;
      audioRef.current = audio;
      if (opts?.onEnded) audio.onended = opts.onEnded;

      try {
        // Route through the shared tap so a self-tape recording (if any)
        // picks this line up directly, not acoustically off the mic. Still
        // connected to the context's own destination so normal speaker
        // playback is unchanged.
        const { context, destination } = ensureTap();
        // Unconditional: also clears Safari's "interrupted" state (distinct
        // from "suspended"), which resume() handles even though the state
        // name doesn't match the naive equality check.
        await context.resume();
        const source = context.createMediaElementSource(audio);
        source.connect(context.destination);
        source.connect(destination);
        sourceNodeRef.current = source;

        await audio.play();
      } catch {
        if (opts?.signal?.aborted) return;
        audioRef.current = null;
        return speakWithBrowserVoice(line.text, opts);
      }
    },
    [stop, ensureTap]
  );

  /** Adjusts the rate of whatever is currently playing (and nothing else). */
  const setPlaybackRate = useCallback((speed: number) => {
    if (audioRef.current) audioRef.current.playbackRate = speed;
  }, []);

  useEffect(() => stop, [stop]);

  return { play, prefetch, stop, setPlaybackRate, getTapStream, unlock };
}
