import { useCallback, useEffect, useRef } from "react";
import { logAudioEvent } from "../lib/audioDiagnostics";
import { clampCharacterVolume } from "../lib/characterVolume";
import { NativeMedia } from "../lib/native/nativeMedia";
import { toBase64 } from "../lib/pcm";
import { cacheKey, type TtsIntensity, type TtsLine } from "../lib/ttsCacheKey";
import { describeError, getBlob, speakWithBrowserVoice, type TtsPlayOptions } from "../lib/ttsAudio";

// Lines already handed to the native engine this app session, by cache key:
// each line's audio crosses the bridge once, then replays from the phone.
const loadedKeys = new Set<string>();

async function ensureLoaded(key: string, blob: Blob): Promise<void> {
  if (loadedKeys.has(key)) return;
  await NativeMedia.loadLine({ key, base64: toBase64(new Uint8Array(await blob.arrayBuffer())) });
  loadedKeys.add(key);
}

/**
 * useTtsPlayer in the iOS app: the same fetch, cache and fallback path as the
 * web player (lib/ttsAudio.ts), but lines play through the phone's own audio
 * engine instead of Web Audio. That engine also hears the mic and mixes the
 * take, so there's no tap stream or shared AudioContext to hand out, and no
 * autoplay gate to unlock.
 */
export function useNativeTtsPlayer(options?: {
  scriptId?: string | null;
  onLiveFetch?: () => void;
}) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // The playing line's token and its onEnded; a stop or a newer line
  // replaces it, so a late lineEnded for an old line is ignored.
  const currentRef = useRef<{ token: number; onEnded?: () => void } | null>(null);

  useEffect(() => {
    const listener = NativeMedia.addListener("lineEnded", ({ token }) => {
      const current = currentRef.current;
      if (!current || current.token !== token) return;
      currentRef.current = null;
      current.onEnded?.();
    });
    return () => {
      void listener.then((handle) => handle.remove());
    };
  }, []);

  const stop = useCallback(() => {
    currentRef.current = null;
    void NativeMedia.stopLine();
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  }, []);

  const prefetch = useCallback((line: TtsLine, intensity: TtsIntensity = "natural") => {
    void getBlob(line, intensity, { ...optionsRef.current, waiting: false });
  }, []);

  const play = useCallback(
    async (line: TtsLine, opts?: TtsPlayOptions) => {
      stop();
      logAudioEvent("play", `start "${line.text.slice(0, 24)}" (native)`);
      const intensity = opts?.intensity ?? "natural";
      let blob: Blob;
      try {
        blob = await getBlob(line, intensity, { ...optionsRef.current, waiting: true });
      } catch (err) {
        if (opts?.signal?.aborted) return;
        logAudioEvent("play", `getBlob failed: ${describeError(err, "unknown")} — falling back`);
        opts?.onFallback?.(describeError(err, "Voice playback failed"));
        return speakWithBrowserVoice(line.text, opts);
      }
      if (opts?.signal?.aborted) return;
      try {
        const key = cacheKey(line, intensity);
        await ensureLoaded(key, blob);
        if (opts?.signal?.aborted) return;
        const { token } = await NativeMedia.playLine({
          key,
          rate: opts?.speed ?? 1,
          volume: clampCharacterVolume(opts?.volume),
        });
        currentRef.current = { token, onEnded: opts?.onEnded };
        logAudioEvent("play", "native playback started");
        // The engine resolves once the line is actually rendering.
        opts?.onPlaying?.();
      } catch (err) {
        if (opts?.signal?.aborted) return;
        logAudioEvent("play", `native playback failed: ${describeError(err, "unknown")} — falling back`);
        opts?.onFallback?.(describeError(err, "Audio playback failed"));
        return speakWithBrowserVoice(line.text, opts);
      }
    },
    [stop],
  );

  const load = useCallback(
    (line: TtsLine, intensity: TtsIntensity = "natural") =>
      getBlob(line, intensity, { ...optionsRef.current, waiting: false }),
    [],
  );

  const setPlaybackRate = useCallback((speed: number) => {
    void NativeMedia.setRate({ rate: speed });
  }, []);

  const setVolume = useCallback((volume: number) => {
    void NativeMedia.setVolume({ volume: clampCharacterVolume(volume) });
  }, []);

  // Native audio has no autoplay gate, and the take is mixed natively.
  const unlock = useCallback(() => {}, []);
  const getTapStream = useCallback((): MediaStream | null => null, []);
  const getAudioContext = useCallback((): AudioContext | null => null, []);

  useEffect(() => stop, [stop]);

  return { play, prefetch, load, stop, setPlaybackRate, setVolume, getTapStream, unlock, getAudioContext };
}
