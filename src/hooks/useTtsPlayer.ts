import { useCallback, useEffect, useRef } from "react";
import { logAudioEvent } from "../lib/audioDiagnostics";
import { clampCharacterVolume } from "../lib/characterVolume";
import { routeToPreferredSpeaker } from "../lib/mediaDevices";
import { IS_NATIVE } from "../lib/platform";
import type { TtsIntensity, TtsLine } from "../lib/ttsCacheKey";
import {
  describeError,
  getBlob,
  SILENT_AUDIO_DATA_URI,
  speakWithBrowserVoice,
  type TtsPlayOptions,
} from "../lib/ttsAudio";
import { useNativeTtsPlayer } from "./useTtsPlayer.native";

export { cacheKey } from "../lib/ttsCacheKey";
export type { TtsIntensity, TtsLine } from "../lib/ttsCacheKey";
export {
  fetchTtsBlobWithRetry,
  peekTtsCache,
  seedTtsCache,
  trackPregenFetch,
  TtsRateLimitError,
  type TtsFetchOptions,
  type TtsPlayOptions,
} from "../lib/ttsAudio";

/**
 * TTS playback backed by the session-wide audio cache. The rehearsal screen
 * prefetches the next AI line while the current step plays to keep auto-flow
 * seamless.
 */
function useWebTtsPlayer(options?: {
  /** Saved script whose live-fetched lines get stored on-device. */
  scriptId?: string | null;
  /** Called whenever a line has to come from (or wait on) the network
   * instead of a cache — the rehearsal counts these during a take. */
  onLiveFetch?: () => void;
}) {
  // Latest options, read at lookup time so play/prefetch stay stable.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // One <audio> element, reused for every line rather than replaced: some
  // WebKit versions scope the "has played audible media from a gesture"
  // autoplay unlock to the specific element that played, not the page as a
  // whole, so a fresh `new Audio()` per line can each need their own gesture
  // even after Start's primer already played successfully. Reusing the same
  // element covers that case too, whichever way the unlock is actually scoped.
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
  // createMediaElementSource can only ever be called once per element, so
  // this is created lazily on first use and then kept for the session —
  // matching the one persistent audioRef element it's built from.
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  // Every line passes through compressor -> gain before reaching both the
  // speakers and the self-tape tap, so the recorded mix carries exactly the
  // level the actor heard. The gain is set per line to its speaker's level,
  // after the compressor so the compressor doesn't even it back out. Built
  // alongside the context in ensureTap.
  const compressorRef = useRef<DynamicsCompressorNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);

  const ensureAudioElement = useCallback(() => {
    if (!audioRef.current) {
      audioRef.current = new Audio();
      routeToPreferredSpeaker(audioRef.current);
    }
    return audioRef.current;
  }, []);

  const ensureTap = useCallback(() => {
    if (!audioContextRef.current) {
      const context = new AudioContext();
      // The actor's chosen output from the setup step, where supported.
      routeToPreferredSpeaker(context);
      logAudioEvent(
        "ctx",
        `created, initial state=${context.state}, sampleRate=${context.sampleRate}`,
      );
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
      // v3 renders vary a lot in loudness line to line (a [whispers] line
      // next to an [angry] one), which beta testers heard as the reader
      // randomly getting louder and quieter. A gentle compressor evens that
      // out at playback time, with no per-line measurement or regeneration.
      const compressor = context.createDynamicsCompressor();
      compressor.threshold.value = -24;
      compressor.ratio.value = 4;
      compressor.knee.value = 10;
      const gain = context.createGain();
      compressor.connect(gain);
      gain.connect(context.destination);
      gain.connect(tapDestinationRef.current);
      compressorRef.current = compressor;
      gainNodeRef.current = gain;
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
      () =>
        logAudioEvent("unlock", `resume() resolved, state=${context.state}`),
      (err) => logAudioEvent("unlock", `resume() rejected: ${err}`),
    );
    // Must be a real, unmuted play() call made synchronously in this same
    // gesture — a resumed-but-silent AudioContext doesn't satisfy WebKit's
    // "has this page played audible media from a gesture" flag on its own.
    // Played on the SAME element every subsequent line reuses (not a
    // throwaway one) in case the unlock is scoped to that specific element
    // rather than the page.
    const audio = ensureAudioElement();
    audio.src = SILENT_AUDIO_DATA_URI;
    audio.play().then(
      () => logAudioEvent("unlock", "silent primer play() resolved"),
      (err) => logAudioEvent("unlock", `silent primer play() rejected: ${err}`),
    );
  }, [ensureTap, ensureAudioElement]);

  /** The shared context itself, for callers (self-tape recording) that need
   * to build their own nodes on it rather than duplicate an AudioContext of
   * their own — one context for the whole rehearsal is one thing to keep
   * resumed on mobile instead of several. */
  const getAudioContext = useCallback(() => ensureTap().context, [ensureTap]);

  const stop = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.onended = null;
      audioRef.current.onplaying = null;
    }
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    // sourceNodeRef is intentionally left connected: it's created once for
    // the one, reused <audio> element (see ensureAudioElement) and kept for
    // the life of the session — createMediaElementSource can only ever be
    // called once per element, so disconnecting and recreating it per line
    // isn't an option once that element is reused rather than replaced.
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
  }, []);

  const prefetch = useCallback(
    (line: TtsLine, intensity: TtsIntensity = "natural") => {
      void getBlob(line, intensity, { ...optionsRef.current, waiting: false });
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
        blob = await getBlob(line, opts?.intensity ?? "natural", {
          ...optionsRef.current,
          waiting: true,
        });
      } catch (err) {
        if (opts?.signal?.aborted) return;
        logAudioEvent(
          "play",
          `getBlob failed: ${describeError(err, "unknown")} — falling back`,
        );
        opts?.onFallback?.(describeError(err, "Voice playback failed"));
        return speakWithBrowserVoice(line.text, opts);
      }
      if (opts?.signal?.aborted) return;

      const url = URL.createObjectURL(blob);
      audioUrlRef.current = url;
      // Reused, not recreated: see the comment on audioRef's declaration.
      const audio = ensureAudioElement();
      audio.src = url;
      audio.currentTime = 0;
      audio.playbackRate = opts?.speed ?? 1;
      audio.onended = opts?.onEnded ?? null;
      audio.onplaying = opts?.onPlaying ?? null;

      try {
        // Route through the shared tap so a self-tape recording (if any)
        // picks this line up directly, not acoustically off the mic. Still
        // connected to the context's own destination so normal speaker
        // playback is unchanged.
        const { context } = ensureTap();
        // Unconditional: also clears Safari's "interrupted" state (distinct
        // from "suspended"), which resume() handles even though the state
        // name doesn't match the naive equality check.
        await context.resume();
        // createMediaElementSource can only be called once per element —
        // now that the element is reused, so is this node, created lazily.
        // It feeds the compressor, which in turn reaches both the speakers
        // and the tap (see ensureTap).
        if (!sourceNodeRef.current) {
          const source = context.createMediaElementSource(audio);
          source.connect(compressorRef.current!);
          sourceNodeRef.current = source;
        }
        gainNodeRef.current!.gain.value = clampCharacterVolume(opts?.volume);

        await audio.play();
        logAudioEvent(
          "play",
          `audio.play() resolved, ctx.state=${context.state}`,
        );
      } catch (err) {
        if (opts?.signal?.aborted) return;
        logAudioEvent(
          "play",
          `audio.play() rejected: ${describeError(err, "unknown")} — falling back`,
        );
        opts?.onFallback?.(describeError(err, "Audio playback blocked"));
        return speakWithBrowserVoice(line.text, opts);
      }
    },
    [stop, ensureTap, ensureAudioElement],
  );

  /**
   * The line's audio, from the cache or generated (and stored, like any line
   * play() fetches) — without playing it, or falling back to the browser
   * voice if it fails: rejects instead. For callers that need to know a line
   * really rendered before they play it (the coaching screen).
   */
  const load = useCallback(
    (line: TtsLine, intensity: TtsIntensity = "natural") =>
      getBlob(line, intensity, { ...optionsRef.current, waiting: false }),
    [],
  );

  /** Adjusts the rate of whatever is currently playing (and nothing else). */
  const setPlaybackRate = useCallback((speed: number) => {
    if (audioRef.current) audioRef.current.playbackRate = speed;
  }, []);

  /** Changes the level of whatever is currently playing (a voice preview
   * following its slider); the next line sets its own. */
  const setVolume = useCallback((volume: number) => {
    if (gainNodeRef.current) gainNodeRef.current.gain.value = clampCharacterVolume(volume);
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
      compressorRef.current = null;
      gainNodeRef.current = null;
    };
  }, []);

  return {
    play,
    prefetch,
    load,
    stop,
    setPlaybackRate,
    setVolume,
    getTapStream,
    unlock,
    getAudioContext,
  };
}

/** What either player offers. The tap stream and shared context exist only
 * on the web, where the take is mixed in Web Audio; in the iOS app the take
 * is mixed natively, so they're null there. */
export type TtsPlayer = Omit<ReturnType<typeof useWebTtsPlayer>, "getTapStream" | "getAudioContext"> & {
  getTapStream: () => MediaStream | null;
  getAudioContext: () => AudioContext | null;
};

/** The scene partner's voice. In the iOS app it plays through the phone's
 * own audio engine (useTtsPlayer.native.ts); everywhere else through Web
 * Audio, as it always has. Chosen once, at load. */
export const useTtsPlayer: (options?: Parameters<typeof useWebTtsPlayer>[0]) => TtsPlayer = IS_NATIVE
  ? useNativeTtsPlayer
  : useWebTtsPlayer;
