// Permanent local store for self-tape recordings — replaces the "self-tapes"
// Supabase Storage bucket and self_tapes table. A take is saved here the
// instant recording finishes (see useSelfTapeSession.ts); My Account,
// FeedbackGate, and playback all read straight from IndexedDB, no network
// round trip and no separate upload step. Audition feedback (rating/comment)
// is the one exception: it's written to the public.self_tape_feedback table
// in Supabase (see submitFeedback below) so the team can read it — only the
// "still owe feedback" flag stays local, for gating FeedbackGate.tsx.
import { SELF_TAPES_STORE, withStore } from "./localDb";
import { supabase } from "./supabase";
import type { TakeMetricsRow } from "./takeMetrics";
import { clampReaderVolume, type TapeStems } from "./tapeRemix";
import type { SelfTape } from "../types";

type TapeRecord = {
  id: string;
  userId: string;
  scriptId: string;
  /** Character read for this take; missing on rows saved before this field
   * existed. */
  role?: string;
  mimeType: string;
  blob: Blob;
  createdAt: string;
  feedbackRequired: boolean;
  feedbackSubmittedAt: string | null;
  /** Rehearsal telemetry for this take (lib/takeMetrics.ts), held here until
   * the feedback row it's sent with is inserted — the take is saved, then
   * the app navigates to My Account, and only then does FeedbackGate ask for
   * a rating. Missing on rows saved before this field existed. */
  metrics?: TakeMetricsRow;
  /** Mic-only and reader-only audio recorded alongside the video, so the
   * reader's level can be changed on review (lib/tapeRemix.ts). Missing on
   * takes recorded before this existed, or whose stems failed to record.
   * Kept on the same record as the video, so deleting the tape deletes them. */
  stems?: TapeStems;
  /** Reader level last chosen for this take on review (1 = as recorded). */
  readerVolume?: number;
};

/** What the review screen needs to rebuild a take's mix. */
export type TapeMix = { stems: TapeStems | null; readerVolume: number };

export type NewSelfTape = {
  id: string;
  userId: string;
  scriptId: string;
  role: string;
  mimeType: string;
};

/** mp4 on Safari (iOS and desktop), webm everywhere else — see
 * useSelfTapeRecorder.ts's pickMimeType(). Used for both the recorded
 * take's own filename and, on replay, the downloaded file's extension. */
export function extensionForMimeType(mimeType: string): string {
  return mimeType.includes("mp4") ? "mp4" : "webm";
}

function toSelfTape(record: TapeRecord): SelfTape {
  return {
    id: record.id,
    script_id: record.scriptId,
    role: record.role ?? "",
    created_at: record.createdAt,
    feedback_required: record.feedbackRequired,
    feedback_submitted_at: record.feedbackSubmittedAt,
  };
}

export async function saveTape(
  meta: NewSelfTape,
  blob: Blob,
  metrics?: TakeMetricsRow,
  stems?: TapeStems | null,
): Promise<void> {
  const record: TapeRecord = {
    ...meta,
    blob,
    metrics,
    ...(stems ? { stems } : {}),
    createdAt: new Date().toISOString(),
    feedbackRequired: true,
    feedbackSubmittedAt: null,
  };
  await withStore(SELF_TAPES_STORE, "readwrite", (store) => store.put(record));
}

export async function listTapes(userId: string): Promise<SelfTape[]> {
  const all = await withStore<TapeRecord[]>(SELF_TAPES_STORE, "readonly", (store) =>
    store.getAll(),
  );
  return all
    .filter((record) => record.userId === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(toSelfTape);
}

export async function getTapeBlob(id: string): Promise<Blob | null> {
  const record = await withStore<TapeRecord | undefined>(
    SELF_TAPES_STORE,
    "readonly",
    (store) => store.get(id),
  );
  return record?.blob ?? null;
}

export async function getTapeMix(id: string): Promise<TapeMix | null> {
  const record = await withStore<TapeRecord | undefined>(
    SELF_TAPES_STORE,
    "readonly",
    (store) => store.get(id),
  );
  if (!record) return null;
  return { stems: record.stems ?? null, readerVolume: clampReaderVolume(record.readerVolume) };
}

/** Remembers the reader level chosen for a take on review. */
export async function setTapeReaderVolume(id: string, volume: number): Promise<void> {
  const existing = await withStore<TapeRecord | undefined>(
    SELF_TAPES_STORE,
    "readonly",
    (store) => store.get(id),
  );
  if (!existing) return;
  const updated: TapeRecord = { ...existing, readerVolume: clampReaderVolume(volume) };
  await withStore(SELF_TAPES_STORE, "readwrite", (store) => store.put(updated));
}

export async function deleteTape(id: string): Promise<void> {
  await withStore(SELF_TAPES_STORE, "readwrite", (store) => store.delete(id));
}

export async function deleteTapesForScript(scriptId: string): Promise<string[]> {
  const all = await withStore<TapeRecord[]>(SELF_TAPES_STORE, "readonly", (store) =>
    store.getAll(),
  );
  const ids = all.filter((record) => record.scriptId === scriptId).map((record) => record.id);
  await Promise.all(ids.map((id) => deleteTape(id)));
  return ids;
}

/** Oldest tape still owed feedback, or null — the beta requirement enforced
 * by FeedbackGate.tsx (see src/lib/beta.ts for the flag that turns it off). */
export async function getPendingFeedbackTape(userId: string): Promise<SelfTape | null> {
  const tapes = await listTapes(userId); // newest-first
  const pending = tapes.filter(
    (tape) => tape.feedback_required && !tape.feedback_submitted_at,
  );
  return pending.length > 0 ? pending[pending.length - 1] : null;
}

export async function submitFeedback(
  id: string,
  rating: number,
  comment: string | null,
): Promise<void> {
  const existing = await withStore<TapeRecord | undefined>(
    SELF_TAPES_STORE,
    "readonly",
    (store) => store.get(id),
  );
  if (!existing) return;

  const feedback = {
    user_id: existing.userId,
    tape_id: existing.id,
    script_id: existing.scriptId,
    rating,
    comment,
    recorded_at: existing.createdAt,
  };
  let { error } = await supabase
    .from("self_tape_feedback")
    .insert({ ...feedback, ...existing.metrics });
  // The metrics columns arrive in their own migration
  // (20261008120000_self_tape_feedback_metrics.sql); if a database hasn't had
  // it applied yet, losing the metrics beats losing the feedback, which the
  // beta depends on — so retry with the rating/comment alone.
  if (error && existing.metrics && isMissingColumnError(error)) {
    console.warn("self_tape_feedback metrics columns missing; saving feedback without them:", error);
    ({ error } = await supabase.from("self_tape_feedback").insert(feedback));
  }
  if (error) throw error;

  const updated: TapeRecord = {
    ...existing,
    feedbackSubmittedAt: new Date().toISOString(),
  };
  await withStore(SELF_TAPES_STORE, "readwrite", (store) => store.put(updated));
}

/** PostgREST's "column not in the schema cache" (PGRST204) or Postgres's own
 * undefined_column (42703). */
function isMissingColumnError(error: { code?: string }): boolean {
  return error.code === "PGRST204" || error.code === "42703";
}
