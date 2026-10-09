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
import { buildReaderLine, readerLineIndices } from "../lib/readerLines";
import { enforceReaderAudioCap, loadReaderAudio, saveReaderAudio } from "../lib/readerAudioStore";
import {
  canStartTake,
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
  /** Reader lines with audio ready (cached in memory/on-device or generated). */
  ready: number;
  total: number;
  failed: number;
  /** Every reader line is either ready or given up on. */
  done: boolean;
  /** Start gate: done, or the opening reader lines are ready. */
  canStart: boolean;
  /** Client time the current generation job started (null before it has). */
  startedAt: number | null;
  /** Client time the current job finished (null while still running). */
  finishedAt: number | null;
};

/** What useReaderAudioPregen returns: its state plus the playhead setter. */
export type ReaderAudioPregen = ReaderAudioPregenState & {
  setPlayhead: (index: number, takeActive: boolean) => void;
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
 * Generates every reader line's audio ahead of the take, in script order, so
 * the scene partner answers without an ElevenLabs round trip. Lines already
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
  deliveryTags,
  intensity,
  scriptId,
}: {
  enabled: boolean;
  steps: Step[];
  selectedRole: string;
  characterVoices: Record<string, string>;
  /** null until the AI director answers (or forever if it failed). */
  deliveryTags: (string | null)[] | null;
  intensity: TtsIntensity;
  /** Saved script the audio is stored under; null keeps it in memory only. */
  scriptId: string | null;
}): ReaderAudioPregen {
  const [state, setState] = useState<ReaderAudioPregenState>(IDLE);
  const [tagsWaitExpired, setTagsWaitExpired] = useState(false);

  useEffect(() => {
    if (!enabled || deliveryTags !== null || tagsWaitExpired) return;
    const timer = setTimeout(() => setTagsWaitExpired(true), TAGS_WAIT_MS);
    return () => clearTimeout(timer);
  }, [enabled, deliveryTags, tagsWaitExpired]);

  // The exact requests Rehearsal will make, keyed the same way. Untagged
  // once the wait for the director runs out, as Rehearsal reads them.
  const lines = useMemo(() => {
    const tags = deliveryTags ?? (tagsWaitExpired ? [] : null);
    if (!enabled || tags === null) return null;
    return readerLineIndices(steps, selectedRole).flatMap((index) => {
      const line = buildReaderLine(steps, index, characterVoices, tags);
      return line ? [{ index, line, key: cacheKey(line, intensity) }] : [];
    });
  }, [enabled, steps, selectedRole, characterVoices, deliveryTags, tagsWaitExpired, intensity]);
  // Restart only when the set of keys actually changes, not on every new
  // array identity (e.g. a re-render that rebuilt equal tags).
  const signature = lines ? JSON.stringify(lines.map((item) => item.key)) : null;
  const linesRef = useRef(lines);
  linesRef.current = lines;

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
    let cancelled = false;
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

    const publish = (finished: boolean) => {
      if (cancelled) return;
      setState({
        waitingForDirection: false,
        ready: ready.size,
        total: readerIndices.length,
        failed: failed.size,
        done: finished,
        canStart: canStartTake(readerIndices, ready, finished),
        startedAt,
        finishedAt: finished ? Date.now() : null,
      });
    };

    const markReady = (index: number) => {
      pending.delete(index);
      ready.add(index);
    };

    const generate = async (index: number, line: TtsLine, key: string) => {
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
        if (scriptId) {
          void saveReaderAudio(key, scriptId, blob).catch((err) =>
            console.warn("Couldn't store reader audio on-device:", err),
          );
        }
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
      publish(false);
      // Opening lines first: anything already in memory or on-device is
      // ready immediately and costs nothing.
      await Promise.all(
        items.map(async ({ index, key }) => {
          if (peekTtsCache(key)) return; // generate() settles it in order
          const stored = await loadReaderAudio(key).catch(() => null);
          if (stored && !cancelled) {
            seedTtsCache(key, stored);
            markReady(index);
          }
        }),
      );
      if (cancelled) return;
      publish(pending.size === 0);

      const running = new Map<number, Promise<void>>();
      while (!cancelled && (pending.size > running.size || running.size > 0)) {
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
            publish(pending.size === 0 && running.size === 0);
          });
          running.set(next, job);
        }
        if (running.size === 0) break;
        const wake = new Promise<void>((resolve) => { wakeRef.current = resolve; });
        await Promise.race([wake, ...running.values()]);
      }
      publish(true);
      // Generation just added to the store; trim it back under its caps,
      // never touching the script being rehearsed except over its own cap.
      if (!cancelled && scriptId) {
        void enforceReaderAudioCap(scriptId).catch((err) =>
          console.warn("Reader audio eviction failed:", err),
        );
      }
    };

    void run();
    return () => {
      cancelled = true;
      wakeRef.current();
      wakeRef.current = () => {};
    };
  }, [enabled, signature, intensity, scriptId]);

  return { ...state, setPlayhead };
}
