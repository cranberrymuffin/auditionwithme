import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Step } from "../types";
import {
  cacheKey,
  fetchTtsBlobWithRetry,
  peekTtsCache,
  seedTtsCache,
  trackPregenFetch,
  TtsRateLimitError,
  type TtsIntensity,
  type TtsLine,
} from "./useTtsPlayer";
import { buildReaderLine, keepUntaggedReads, readerLineIndices } from "../lib/readerLines";
import { enforceReaderAudioCap, loadReaderAudio, saveReaderAudio } from "../lib/readerAudioStore";
import {
  canStartTake,
  lookaheadWindow,
  nextLineToGenerate,
  parseConcurrency,
  PREGEN_HOLD_MS,
  shouldHoldPregen,
  targetWorkers,
  type Concurrency,
} from "../lib/pregenSchedule";

// Delivery tags are part of the cache key, so generating before the AI
// director answers would just be thrown away when its tags land. Wait this
// long for them, then generate unadorned (what Rehearsal plays without tags).
const TAGS_WAIT_MS = 15_000;
// A line held/429'd this many times in a row is given up on (and left to a
// live fetch at playback) rather than retried forever on a busy account.
const MAX_HOLDS_PER_LINE = 10;
const PREGEN_HEADERS = { "X-TTS-Purpose": "pregen" };

export type ReaderAudioPregenState = {
  /** Waiting on the AI director's tags before generating anything. */
  waitingForDirection: boolean;
  /** Reader lines in the lookahead window (lib/pregenSchedule.ts) with audio
   * ready — cached in memory/on-device or generated — out of `total`, the
   * window's size. The window, not the script: lines past it aren't
   * generated yet, so they'd never count towards a whole-script total. */
  ready: number;
  total: number;
  failed: number;
  /** Every line in the window is either ready or given up on. */
  done: boolean;
  /** Start gate: done, or the window's opening lines are ready. */
  canStart: boolean;
  /** Client time the current generation job started (null before it has). */
  startedAt: number | null;
  /** Client time the window was first all settled (null until then). */
  finishedAt: number | null;
};

/** What useReaderAudioPregen returns: its state plus the playhead setter. */
export type ReaderAudioPregen = ReaderAudioPregenState & {
  setPlayhead: (index: number, takeActive: boolean) => void;
  /** The tags Rehearsal must read with so playback hits what was generated:
   * the director's, minus lines already rendered untagged before they came
   * (see keepUntaggedReads). Null while still waiting on the director. */
  deliveryTags: (string | null)[] | null;
};

const IDLE: ReaderAudioPregenState = {
  waitingForDirection: false,
  ready: 0,
  total: 0,
  failed: 0,
  done: false,
  canStart: false,
  startedAt: null,
  finishedAt: null,
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Generates reader lines' audio ahead of the actor, in script order, so the
 * scene partner answers without an ElevenLabs round trip — only the next
 * PREGEN_LOOKAHEAD_LINES of them from the actor's current step, moving on as
 * the actor does, so a take that stops early never pays for the rest of the
 * script. Lines already
 * in memory or the on-device store cost nothing (a Recast with unchanged
 * voices is free); changed voices or direction are different cache keys and
 * regenerate. Keeps running through the take — one worker only — prioritizing
 * lines from the actor's current step on; `setPlayhead` tells it where that is.
 * Concurrency is deliberately small: see lib/pregenSchedule.ts.
 */
export function useReaderAudioPregen({
  enabled,
  steps,
  selectedRole,
  characterVoices,
  characterEmotions,
  coachTakes,
  deliveryTags,
  intensity,
  scriptId,
  languageCode,
}: {
  enabled: boolean;
  steps: Step[];
  selectedRole: string;
  characterVoices: Record<string, string>;
  /** Speaker → emotion setting (lib/characterDelivery.ts); part of the key. */
  characterEmotions: Record<string, number>;
  /** Step index → coached take id (coachTakeStore.ts); part of the key. */
  coachTakes: Record<number, string>;
  /** null until the AI director answers (or forever if it failed). */
  deliveryTags: (string | null)[] | null;
  intensity: TtsIntensity;
  /** Script the audio is stored under on-device. */
  scriptId: string;
  /** The script's language; part of the key off English. */
  languageCode: string;
}): ReaderAudioPregen {
  const [state, setState] = useState<ReaderAudioPregenState>(IDLE);
  const [tagsWaitExpired, setTagsWaitExpired] = useState(false);

  useEffect(() => {
    if (!enabled || deliveryTags !== null || tagsWaitExpired) return;
    const timer = setTimeout(() => setTagsWaitExpired(true), TAGS_WAIT_MS);
    return () => clearTimeout(timer);
  }, [enabled, deliveryTags, tagsWaitExpired]);

  // Keys of reads generated (or found) untagged while the director was late.
  // Only grows while tags are missing, so it's settled by the time they land.
  const untaggedKeysRef = useRef(new Set<string>());

  // Untagged once the wait for the director runs out. Tags that land after
  // that leave the lines already rendered untagged as they are — those reads
  // are paid for — and direct only the rest. "Already rendered" includes
  // reads Rehearsal fetched itself before this job reached them: they're in
  // the in-memory cache (in flight or done; failures leave it), and nothing
  // fetches untagged reads unless the wait ran out.
  const effectiveTags = useMemo(() => {
    if (deliveryTags === null) return tagsWaitExpired ? [] : null;
    // The wait only expires while tags are missing, so this means they're late.
    if (!tagsWaitExpired) return deliveryTags;
    const paid = untaggedKeysRef.current;
    const keep = readerLineIndices(steps, selectedRole).filter((index) => {
      const line = buildReaderLine(steps, index, characterVoices, [], characterEmotions, coachTakes, languageCode);
      if (!line) return false;
      const key = cacheKey(line, intensity);
      return paid.has(key) || peekTtsCache(key) !== undefined;
    });
    return keep.length ? keepUntaggedReads(steps, deliveryTags, keep) : deliveryTags;
  }, [deliveryTags, tagsWaitExpired, steps, selectedRole, characterVoices, characterEmotions, coachTakes, intensity, languageCode]);

  // The exact requests Rehearsal will make, keyed the same way.
  const lines = useMemo(() => {
    const tags = effectiveTags;
    if (!enabled || tags === null) return null;
    return readerLineIndices(steps, selectedRole).flatMap((index) => {
      const line = buildReaderLine(steps, index, characterVoices, tags, characterEmotions, coachTakes, languageCode);
      return line ? [{ index, line, key: cacheKey(line, intensity) }] : [];
    });
  }, [enabled, steps, selectedRole, characterVoices, characterEmotions, coachTakes, effectiveTags, intensity, languageCode]);
  // Restart only when the set of keys actually changes, not on every new
  // array identity (e.g. a re-render that rebuilt equal tags).
  const signature = lines ? JSON.stringify(lines.map((item) => item.key)) : null;
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const untaggedRef = useRef(deliveryTags === null);
  untaggedRef.current = deliveryTags === null;

  // Where the actor is, and whether a take is under way; read by the job.
  const playheadRef = useRef({ index: 0, takeActive: false });
  const wakeRef = useRef<() => void>(() => {});
  const setPlayhead = useCallback((index: number, takeActive: boolean) => {
    const previous = playheadRef.current;
    if (previous.index === index && previous.takeActive === takeActive) return;
    playheadRef.current = { index, takeActive };
    wakeRef.current();
  }, []);

  useEffect(() => {
    if (!enabled) {
      setState(IDLE);
      return;
    }
    if (signature === null) {
      setState({ ...IDLE, waitingForDirection: true });
      return;
    }
    const items = linesRef.current ?? [];
    // Running on the timed-out, untagged reads: remember each one touched.
    const untagged = untaggedRef.current;
    const noteUntagged = (key: string) => {
      if (untagged) untaggedKeysRef.current.add(key);
    };
    let cancelled = false;
    // Only gates the WAIT between retry/backoff attempts (threaded into
    // fetchTtsBlobWithRetry below) and the rate-limit hold wait in the loop
    // further down — never a request already sent to ElevenLabs. Once a line
    // is generating server-side the credits are spent either way, so letting
    // it finish and still save the blob (on-device store + in-memory cache)
    // is strictly better than throwing the result away on cleanup.
    const abortController = new AbortController();
    const startedAt = Date.now();
    const readerIndices = items.map((item) => item.index);
    const byIndex = new Map(items.map((item) => [item.index, item]));
    const ready = new Set<number>();
    const failed = new Set<number>();
    const pending = new Set<number>(readerIndices);
    const holds = new Map<number, number>();
    let rateLimited = false;
    let concurrency: Concurrency | null = null;
    let holdUntil = 0;

    let finishedAt: number | null = null;
    const publish = () => {
      if (cancelled) return;
      const window = lookaheadWindow(readerIndices, playheadRef.current.index);
      const done = window.every((index) => ready.has(index) || failed.has(index));
      if (done) finishedAt ??= Date.now();
      setState({
        waitingForDirection: false,
        ready: window.filter((index) => ready.has(index)).length,
        total: window.length,
        failed: failed.size,
        done,
        canStart: canStartTake(window, ready, done),
        startedAt,
        finishedAt,
      });
    };

    const markReady = (index: number) => {
      pending.delete(index);
      ready.add(index);
    };

    const generate = async (index: number, line: TtsLine, key: string) => {
      noteUntagged(key);
      // Something (playback, its prefetch) already has this line.
      const existing = peekTtsCache(key);
      if (existing) {
        try {
          await existing;
          markReady(index);
          return;
        } catch {
          // fall through and generate it ourselves
        }
      }
      const request = fetchTtsBlobWithRetry(line, intensity, {
        headers: PREGEN_HEADERS,
        retryRateLimit: false,
        signal: abortController.signal,
        onResponse: (res) => {
          const reading = parseConcurrency(
            res.headers.get("X-TTS-Current-Concurrent"),
            res.headers.get("X-TTS-Max-Concurrent"),
          );
          if (reading) concurrency = reading;
          if (shouldHoldPregen(reading)) holdUntil = Math.max(holdUntil, Date.now() + PREGEN_HOLD_MS);
        },
      });
      if (!trackPregenFetch(key, request)) {
        // Lost a race with playback; let ours finish (it's already paid
        // for) but count the line by whichever request owns the slot.
        request.catch(() => {});
        try {
          await peekTtsCache(key);
          markReady(index);
        } catch {
          pending.delete(index);
          failed.add(index);
        }
        return;
      }
      try {
        const blob = await request;
        markReady(index);
        void saveReaderAudio(key, scriptId, blob).catch((err) =>
          console.warn("Couldn't store reader audio on-device:", err),
        );
      } catch (err) {
        if (err instanceof TtsRateLimitError) {
          // Held by api/tts.ts or 429'd upstream: wait as told, and stay at
          // one worker for the rest of this job.
          rateLimited = true;
          holdUntil = Math.max(holdUntil, Date.now() + (err.retryAfterMs ?? PREGEN_HOLD_MS));
          const count = (holds.get(index) ?? 0) + 1;
          holds.set(index, count);
          if (count < MAX_HOLDS_PER_LINE) return; // stays pending
        }
        console.warn("Reader line pre-generation failed:", err);
        pending.delete(index);
        failed.add(index);
      }
    };

    const run = async () => {
      // Anything already in memory or on-device is ready immediately and
      // costs nothing. Checked before the first publish, so returning to
      // step 4 doesn't show progress starting over.
      await Promise.all(
        items.map(async ({ index, key }) => {
          if (peekTtsCache(key)) return; // generate() settles it in order
          const stored = await loadReaderAudio(key).catch(() => null);
          if (stored && !cancelled) {
            noteUntagged(key);
            seedTtsCache(key, stored);
            markReady(index);
          }
        }),
      );
      if (cancelled) return;
      publish();

      // Generation adds to the on-device store; trim it back under its caps,
      // never touching the script being rehearsed except over its own cap.
      // Run whenever the job goes idle with something new stored, since a
      // job waiting on the playhead may not end until the take does.
      let trimmedAt = ready.size;
      const trimStore = () => {
        if (cancelled || ready.size === trimmedAt) return;
        trimmedAt = ready.size;
        void enforceReaderAudioCap(scriptId).catch((err) =>
          console.warn("Reader audio eviction failed:", err),
        );
      };

      const running = new Map<number, Promise<void>>();
      // `running` lines are still in `pending`, so this is "work left".
      while (!cancelled && pending.size > 0) {
        const now = Date.now();
        if (now < holdUntil) {
          const wake = new Promise<void>((resolve) => { wakeRef.current = resolve; });
          await Promise.race([sleep(holdUntil - now), wake, ...running.values()]);
          continue;
        }
        const { index: playhead, takeActive } = playheadRef.current;
        const limit = targetWorkers({ takeActive, rateLimited, concurrency });
        const waiting = new Set([...pending].filter((index) => !running.has(index)));
        while (running.size < limit) {
          const next = nextLineToGenerate(readerIndices, waiting, playhead);
          if (next === null) break;
          waiting.delete(next);
          const item = byIndex.get(next)!;
          const job = generate(next, item.line, item.key).finally(() => {
            running.delete(next);
            publish();
          });
          running.set(next, job);
        }
        const wake = new Promise<void>((resolve) => { wakeRef.current = resolve; });
        if (running.size === 0) {
          // The window is covered: wait for the actor to move (setPlayhead)
          // or for cleanup, rather than render past it.
          publish();
          trimStore();
          await wake;
          continue;
        }
        await Promise.race([wake, ...running.values()]);
      }
      publish();
      trimStore();
    };

    void run();
    return () => {
      cancelled = true;
      abortController.abort();
      wakeRef.current();
      wakeRef.current = () => {};
    };
  }, [enabled, signature, intensity, scriptId]);

  return { ...state, setPlayhead, deliveryTags: effectiveTags };
}
