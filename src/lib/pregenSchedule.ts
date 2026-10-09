// Scheduling decisions for reader-audio pre-generation (useReaderAudioPregen.ts),
// kept pure so benchmarks/pregen.ts can check them under tsx.
//
// The ElevenLabs Starter plan allows 3 concurrent TTS requests for the whole
// account, and api/tts.ts uses one server key, so every user's live playback
// and pre-generation share those 3 slots. Pre-generation therefore stays
// small (1 worker, 2 only when the account is clearly idle), drops to 1 for
// the rest of the job after any 429, and pauses whenever the account is one
// request from its limit — that last slot is reserved for live playback.

/** Start is enabled once this many opening reader lines are ready. */
export const START_EARLY_LINES = 3;
/** Hard per-client cap on concurrent pre-generation requests. */
export const MAX_PREGEN_WORKERS = 2;
/** Pause after a near-limit concurrency reading, when there's no Retry-After. */
export const PREGEN_HOLD_MS = 2000;

/** Account concurrency as last reported by api/tts.ts response headers. */
export type Concurrency = { current: number; max: number };

/** Reads X-TTS-Current-Concurrent / X-TTS-Max-Concurrent; null if either is
 * missing or not a number (e.g. the v2 fallback or a local mock). */
export function parseConcurrency(
  current: string | null,
  max: string | null,
): Concurrency | null {
  if (current === null || max === null) return null;
  const c = Number(current);
  const m = Number(max);
  if (!Number.isFinite(c) || !Number.isFinite(m) || m <= 0) return null;
  return { current: c, max: m };
}

/** True when only one account slot is left: pre-generation must yield it to
 * live playback. Mirrors the server-side hold in api/tts.ts. */
export function shouldHoldPregen(concurrency: Concurrency | null): boolean {
  return concurrency !== null && concurrency.current >= concurrency.max - 1;
}

/**
 * How many pre-generation requests may run at once. One by default; two only
 * before the take, with no 429 seen this job, and a reading showing at least
 * two free slots beyond the one in flight. During a take it's always one, so
 * other users keep headroom.
 */
export function targetWorkers(opts: {
  takeActive: boolean;
  rateLimited: boolean;
  concurrency: Concurrency | null;
}): number {
  const { takeActive, rateLimited, concurrency } = opts;
  if (takeActive || rateLimited || concurrency === null) return 1;
  return concurrency.current <= concurrency.max - 2 ? MAX_PREGEN_WORKERS : 1;
}

/**
 * The next reader line to generate, in script order starting from the
 * playhead, so the actor's upcoming lines come first (and stay ahead of
 * them); lines already behind the playhead only once nothing ahead is left.
 * `readerIndices` is in script order; `pending` holds the step indices still
 * needing audio and not already being fetched.
 */
export function nextLineToGenerate(
  readerIndices: number[],
  pending: ReadonlySet<number>,
  playhead: number,
): number | null {
  let behind: number | null = null;
  for (const index of readerIndices) {
    if (!pending.has(index)) continue;
    if (index >= playhead) return index;
    if (behind === null) behind = index;
  }
  return behind;
}

/** Start gate: every reader line is settled (ready or given up on), or the
 * first START_EARLY_LINES of them (all, if the script has fewer) are ready. */
export function canStartTake(
  readerIndices: number[],
  ready: ReadonlySet<number>,
  done: boolean,
): boolean {
  if (done) return true;
  return readerIndices.slice(0, START_EARLY_LINES).every((index) => ready.has(index));
}
