import { useCallback, useEffect, useRef } from "react";
import { logAudioEvent } from "../lib/audioDiagnostics";
import { clampCharacterVolume } from "../lib/characterVolume";
import { NativeMedia } from "../lib/native/nativeMedia";
import { cacheKey, type TtsIntensity, type TtsLine } from "../lib/ttsCacheKey";
import type { TtsPlayOptions } from "./useTtsPlayer";

// The iOS app's scene-partner player: same contract as useTtsPlayer's web
// player, but lines play through the native playback engine
// (MediaSessionController.swift) instead of an <audio> element and Web
// Audio. Lines come from the same cache and fetch logic, passed in by
// useTtsPlayer.ts so this module doesn't import it back (no import cycle).

type LookupOptions = { scriptId?: string | null; onLiveFetch?: () => void; waiting?: boolean };

export type NativeTtsDeps = {
  getBlob: (line: TtsLine, intensity: TtsIntensity, ctx?: LookupOptions) => Promise<Blob>;
  speakWithBrowserVoice: (text: string, opts?: TtsPlayOptions) => Promise<void>;
  describeError: (err: unknown, fallback: string) => string;
};

// Keys already stored natively this session; the native store itself
// survives restarts, which hasLine checks.
const storedKeys = new Set<string>();

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the line's audio"));
    reader.readAsDataURL(blob);
  });
}

async function ensureStored(key: string, blob: Blob): Promise<void> {
  if (storedKeys.has(key)) return;
  const { loaded } = await NativeMedia.hasLine({ key });
  if (!loaded) await NativeMedia.loadLine({ key, base64: await blobToBase64(blob) });
  storedKeys.add(key);
}

export function makeUseNativeTtsPlayer({ getBlob, speakWithBrowserVoice, describeError }: NativeTtsDeps) {
  return function useNativeTtsPlayer(options?: {
    scriptId?: string | null;
    onLiveFetch?: () => void;
  }) {
    const optionsRef = useRef(options);
    optionsRef.current = options;
    // The playing line's token and its onEnded; a stale `lineEnded` (a line
    // that was stopped or replaced) never matches.
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
        logAudioEvent("play", `native start "${line.text.slice(0, 24)}"`);
        const intensity = opts?.intensity ?? "natural";
        let blob: Blob;
        try {
          blob = await getBlob(line, intensity, { ...optionsRef.current, waiting: true });
        } catch (err) {
          if (opts?.signal?.aborted) return;
          opts?.onFallback?.(describeError(err, "Voice playback failed"));
          return speakWithBrowserVoice(line.text, opts);
        }
        if (opts?.signal?.aborted) return;

        const key = cacheKey(line, intensity);
        try {
          await ensureStored(key, blob);
          if (opts?.signal?.aborted) return;
          const { token } = await NativeMedia.playLine({
            key,
            rate: opts?.speed ?? 1,
            volume: clampCharacterVolume(opts?.volume),
          });
          currentRef.current = { token, onEnded: opts?.onEnded };
          logAudioEvent("play", `native playLine resolved, token=${token}`);
          opts?.onPlaying?.();
        } catch (err) {
          if (opts?.signal?.aborted) return;
          // iOS won't start audio in the background (the take is being
          // ended and saved then); a browser-voice fallback would only try
          // the same thing.
          if (document.hidden) {
            logAudioEvent("play", "native playLine refused in the background; skipped");
            return;
          }
          logAudioEvent("play", `native playLine failed: ${describeError(err, "unknown")} — falling back`);
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

    /** Native audio has no autoplay gate; nothing to unlock. */
    const unlock = useCallback(() => {}, []);

    // The native recorder mixes the scene partner into the take itself, so
    // there's no Web Audio tap or context to hand it (and no stray context
    // to unsettle the audio session the native engine owns).
    const getTapStream = useCallback((): MediaStream | null => null, []);
    const getAudioContext = useCallback((): AudioContext | null => null, []);

    useEffect(() => stop, [stop]);

    return { play, prefetch, load, stop, setPlaybackRate, setVolume, getTapStream, unlock, getAudioContext };
  };
}
