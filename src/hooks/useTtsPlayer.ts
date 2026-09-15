import { useCallback, useEffect, useRef } from "react";
import { apiFetch } from "../lib/api";
import { logAudioEvent } from "../lib/audioDiagnostics";

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
const SILENT_AUDIO_DATA_URI =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

/** Turns whatever a fetch/DOM API threw into a short, displayable reason. */
function describeError(err: unknown, fallback: string): string {
  if (err instanceof DOMException) return `${fallback} (${err.name})`;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

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

// Mobile networks (cellular handoffs, backgrounding, spotty wifi) can leave a
// fetch neither resolving nor rejecting for minutes. Without a timeout that
// hang propagates all the way up through play() — no onEnded, no onFallback,
// no error — so the cue just never gets read and the UI stays stuck on
// "is speaking…" with no way to tell what happened. Aborting after 7s turns
// that silent hang into an ordinary failure the retry/fallback logic already handles.
const FETCH_TIMEOUT_MS = 7_000;

async function fetchTtsBlob(
  line: TtsLine,
  intensity: TtsIntensity,
): Promise<Blob> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await apiFetch("/api/tts", {
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
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) throw new Error("Voice playback timed out");
    throw err;
  } finally {
    clearTimeout(timer);
  }
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

async function fetchTtsBlobWithRetry(
  line: TtsLine,
  intensity: TtsIntensity,
): Promise<Blob> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchTtsBlob(line, intensity);
    } catch (err) {
      if (attempt >= FETCH_RETRY_DELAYS_MS.length) throw err;
      await new Promise((resolve) =>
        setTimeout(resolve, FETCH_RETRY_DELAYS_MS[attempt]),
      );
    }
  }
}

function getBlob(
  line: TtsLine,
  intensity: TtsIntensity,
  fresh = false,
): Promise<Blob> {
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
function speakWithBrowserVoice(
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
    const timer = setTimeout(settle, 6_000);
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = opts?.speed ?? 1;
    utterance.onstart = () => {
      clearTimeout(timer);
      resolve();
    };
    utterance.onend = settle;
    utterance.onerror = settle;
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
  const tapDestinationRef = useRef<MediaStreamAudioDestinationNode | null>(
    null,
  );
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);

  const ensureTap = useCallback(() => {
    if (!audioContextRef.current) {
      const context = new AudioContext();
      logAudioEvent("ctx", `created, initial state=${context.state}, sampleRate=${context.sampleRate}`);
      // Self-heals for the rest of the rehearsal instead of only being
      // resumed at specific checkpoints (Start click, before each play()).
      // On mobile, things besides the checkpoints we know about can also
      // interrupt the shared session — starting the self-tape recorder's
      // MediaRecorder right as the first cues are trying to play is one —
      // so react to every drop instead of guessing at every trigger.
      context.onstatechange = () => {
        logAudioEvent("ctx", `state -> ${context.state}`);
        if (context.state !== "running" && context.state !== "closed") {
          void context.resume();
        }
      };
      audioContextRef.current = context;
      tapDestinationRef.current = context.createMediaStreamDestination();
    }
    return {
      context: audioContextRef.current,
      destination: tapDestinationRef.current!,
    };
  }, []);

  /** MediaStream carrying every line's audio, silent when nothing is playing. */
  const getTapStream = useCallback(
    () => ensureTap().destination.stream,
    [ensureTap],
  );

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
    logAudioEvent("unlock", `called, state before resume=${context.state}`);
    void context.resume().then(
      () => logAudioEvent("unlock", `resume() resolved, state=${context.state}`),
      (err) => logAudioEvent("unlock", `resume() rejected: ${err}`),
    );
    // Must be a real, unmuted play() call made synchronously in this same
    // gesture — a resumed-but-silent AudioContext doesn't satisfy WebKit's
    // "has this page played audible media from a gesture" flag on its own.
    new Audio(SILENT_AUDIO_DATA_URI).play().then(
      () => logAudioEvent("unlock", "silent primer play() resolved"),
      (err) => logAudioEvent("unlock", `silent primer play() rejected: ${err}`),
    );
  }, [ensureTap]);

  /** The shared context itself, for callers (self-tape recording) that need
   * to build their own nodes on it rather than duplicate an AudioContext of
   * their own — one context for the whole rehearsal is one thing to keep
   * resumed on mobile instead of several. */
  const getAudioContext = useCallback(() => ensureTap().context, [ensureTap]);

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

  const prefetch = useCallback(
    (line: TtsLine, intensity: TtsIntensity = "natural") => {
      void getBlob(line, intensity);
    },
    [],
  );

  /**
   * Plays a line; resolves once playback starts and fires onEnded when it
   * finishes. Falls back to the browser's own voice — rather than rejecting
   * — if ElevenLabs can't be reached or the audio element won't play (e.g.
   * an autoplay block), so a cue is (almost) never left unread.
   */
  const play = useCallback(
    async (line: TtsLine, opts?: TtsPlayOptions) => {
      stop();
      logAudioEvent("play", `start "${line.text.slice(0, 24)}"`);
      let blob: Blob;
      try {
        blob = await getBlob(line, opts?.intensity ?? "natural", opts?.fresh);
      } catch (err) {
        if (opts?.signal?.aborted) return;
        logAudioEvent("play", `getBlob failed: ${describeError(err, "unknown")} — falling back`);
        opts?.onFallback?.(describeError(err, "Voice playback failed"));
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
        logAudioEvent("play", `audio.play() resolved, ctx.state=${context.state}`);
      } catch (err) {
        if (opts?.signal?.aborted) return;
        audioRef.current = null;
        logAudioEvent("play", `audio.play() rejected: ${describeError(err, "unknown")} — falling back`);
        opts?.onFallback?.(describeError(err, "Audio playback blocked"));
        return speakWithBrowserVoice(line.text, opts);
      }
    },
    [stop, ensureTap],
  );

  /** Adjusts the rate of whatever is currently playing (and nothing else). */
  const setPlaybackRate = useCallback((speed: number) => {
    if (audioRef.current) audioRef.current.playbackRate = speed;
  }, []);

  useEffect(() => stop, [stop]);

  // Without this, the shared AudioContext outlives the component: leaving a
  // rehearsal (Exit, finishing, starting another script) never closes it, so
  // repeated sessions in the same tab pile up open contexts. iOS Safari caps
  // how many can be open at once, so a few rehearsals in without a page
  // refresh can leave a stale context still contending for the shared audio
  // session — a plausible cause of playback getting progressively "mixed up".
  useEffect(() => {
    return () => {
      void audioContextRef.current?.close();
      audioContextRef.current = null;
    };
  }, []);

  return { play, prefetch, stop, setPlaybackRate, getTapStream, unlock, getAudioContext };
}
