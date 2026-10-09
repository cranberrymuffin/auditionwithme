import { useCallback, useEffect, useRef, useState } from "react";
import { getTapeMix, setTapeReaderVolume, type TapeMix } from "../lib/selfTapeStore";
import { decodeStems, renderRemix, StemMixer, type DecodedStems } from "../lib/stemMixer";
import {
  chooseDownloadPath,
  clampReaderVolume,
  DEFAULT_READER_VOLUME,
  shouldPlayStems,
  type DownloadPath,
} from "../lib/tapeRemix";

// Slider moves land in IndexedDB once the actor stops dragging, not per tick.
const SAVE_DEBOUNCE_MS = 400;

export type ExportProgress = { current: number; total: number };

/**
 * The scene partner volume control on a take's review screen.
 *
 * At 100% the <video> plays its own audio — exactly the mix recorded during
 * the take. Off 100%, on a take that has stems, the video is muted and the
 * mic + reader stems play through Web Audio instead (StemMixer), synced to
 * the video, with the reader on its own gain. Switching only when the level
 * actually leaves 100% means an untouched take never depends on an
 * AudioContext, which iOS won't start without a fresh tap.
 *
 * `video` is the review <video>; `exportHost` is where the tape being
 * re-rendered is shown while a remixed download is produced.
 */
export function useTapeRemix(
  tapeId: string | null,
  video: HTMLVideoElement | null,
  exportHost: HTMLElement | null,
) {
  const [mix, setMix] = useState<TapeMix | null>(null);
  const [volume, setVolume] = useState(DEFAULT_READER_VOLUME);
  const [decoded, setDecoded] = useState<DecodedStems | null>(null);
  const [contextRunning, setContextRunning] = useState(false);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const decodingRef = useRef<Promise<DecodedStems | null> | null>(null);
  const exportAbortRef = useRef<AbortController | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hasStems = !!mix?.stems;

  // Per tape: load its stems and saved level; tear everything down on leave.
  useEffect(() => {
    setMix(null);
    setDecoded(null);
    setVolume(DEFAULT_READER_VOLUME);
    decodingRef.current = null;
    if (!tapeId) return;
    let active = true;
    getTapeMix(tapeId)
      .then((loaded) => {
        if (!active || !loaded) return;
        setMix(loaded);
        setVolume(loaded.readerVolume);
      })
      .catch((err) => console.warn("Couldn't load this take's stems:", err));
    return () => {
      active = false;
      exportAbortRef.current?.abort();
      clearTimeout(saveTimerRef.current);
      if (contextRef.current) {
        // Back to default, so a rehearsal later in this tab can still open
        // the mic (an explicit "playback" session would rule that out).
        const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
        if (session) session.type = "auto";
      }
      void contextRef.current?.close();
      contextRef.current = null;
      setContextRunning(false);
    };
  }, [tapeId]);

  /** The review AudioContext, created and resumed on demand. Call from a
   * user gesture where possible — that's what lets iOS start it. */
  const ensureContext = useCallback((): AudioContext => {
    let context = contextRef.current;
    if (!context) {
      // With the video muted, iOS treats Web Audio as ambient sound and the
      // ringer switch silences it; "playback" keeps it audible (Safari 16.4+).
      const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
      if (session) session.type = "playback";
      context = new AudioContext();
      const created = context;
      created.onstatechange = () => setContextRunning(created.state === "running");
      contextRef.current = created;
    }
    const current = context;
    // A context that starts out running (Chrome, after earlier taps) never
    // fires statechange, so read the state once resume() settles too.
    void current.resume().then(
      () => {
        if (contextRef.current === current) setContextRunning(current.state === "running");
      },
      () => {},
    );
    return current;
  }, []);

  const ensureDecoded = useCallback((): Promise<DecodedStems | null> => {
    if (!decodingRef.current) {
      const stems = mix?.stems;
      if (!stems) return Promise.resolve(null);
      const context = ensureContext();
      decodingRef.current = decodeStems(context, stems).then(
        (result) => {
          if (contextRef.current === context) setDecoded(result);
          return result;
        },
        (err) => {
          console.warn("Couldn't decode this take's stems:", err);
          return null;
        },
      );
    }
    return decodingRef.current;
  }, [mix, ensureContext]);

  const usingStems = shouldPlayStems(hasStems, volume);

  // Decode as soon as the level is off 100% — including a level saved from
  // an earlier visit, so the stems are ready by the first tap.
  useEffect(() => {
    if (usingStems) void ensureDecoded();
  }, [usingStems, ensureDecoded]);

  // Hand the audio to the stems (video muted) only once they can actually
  // be heard: decoded, and the context running. Until then the video keeps
  // its own audio rather than going silent.
  const mixerRef = useRef<StemMixer | null>(null);
  const engaged = usingStems && !!decoded && contextRunning && !!video;
  useEffect(() => {
    const context = contextRef.current;
    if (!engaged || !video || !decoded || !context) return;
    const mixer = new StemMixer(context, decoded, context.destination);
    mixerRef.current = mixer;
    video.muted = true;
    // The native controls' mute button would otherwise bring the video's own
    // audio back on top of the stems, playing the take twice.
    const keepMuted = () => {
      if (!video.muted) video.muted = true;
    };
    video.addEventListener("volumechange", keepMuted);
    mixer.attach(video);
    return () => {
      video.removeEventListener("volumechange", keepMuted);
      mixer.dispose();
      if (mixerRef.current === mixer) mixerRef.current = null;
      video.muted = false;
    };
  }, [engaged, video, decoded]);

  useEffect(() => {
    mixerRef.current?.setReaderVolume(volume);
  }, [volume, engaged]);

  /** Any tap on the review screen: the moment iOS will let audio start. */
  const wakeAudio = useCallback(() => {
    if (usingStems && contextRef.current?.state !== "running") ensureContext();
  }, [usingStems, ensureContext]);

  const changeVolume = useCallback(
    (next: number) => {
      if (!tapeId || !hasStems) return;
      const clamped = clampReaderVolume(next);
      // Inside the slider's own input event, so iOS lets the context start.
      if (shouldPlayStems(true, clamped)) ensureContext();
      setVolume(clamped);
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        void setTapeReaderVolume(tapeId, clamped).catch((err) =>
          console.warn("Couldn't save the scene partner volume:", err),
        );
      }, SAVE_DEBOUNCE_MS);
    },
    [tapeId, hasStems, ensureContext],
  );

  const downloadPath: DownloadPath = chooseDownloadPath(hasStems, volume);

  /** Re-renders the take with the current reader level, in real time.
   * Resolves null if cancelled; throws if the render itself fails. */
  const renderRemixed = useCallback(
    async (source: Blob): Promise<Blob | null> => {
      if (!exportHost) throw new Error("Nowhere to render the tape");
      const context = ensureContext();
      const stems = await ensureDecoded();
      if (!stems) throw new Error("This take's stems couldn't be read");
      const controller = new AbortController();
      exportAbortRef.current = controller;
      video?.pause();
      setExportProgress({ current: 0, total: 0 });
      try {
        return await renderRemix({
          source,
          stems,
          readerVolume: volume,
          context,
          host: exportHost,
          // Ignore anything reported once this export has settled.
          onProgress: (current, total) => {
            if (exportAbortRef.current === controller) setExportProgress({ current, total });
          },
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) return null;
        throw err;
      } finally {
        if (exportAbortRef.current === controller) exportAbortRef.current = null;
        setExportProgress(null);
      }
    },
    [exportHost, ensureContext, ensureDecoded, video, volume],
  );

  const cancelExport = useCallback(() => exportAbortRef.current?.abort(), []);

  return {
    /** Null until the take's record has loaded. */
    hasStems: mix ? hasStems : null,
    volume,
    changeVolume,
    wakeAudio,
    downloadPath,
    renderRemixed,
    exportProgress,
    cancelExport,
  };
}
