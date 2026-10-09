// Permanent local store for self-tape recordings — replaces the "self-tapes"
// Supabase Storage bucket and self_tapes table. A take is saved here the
// instant recording finishes (see useSelfTapeSession.ts); My Account,
// FeedbackGate, and playback all read straight from IndexedDB, no network
// round trip and no separate upload step. Audition feedback (rating/comment)
// is the one exception: it's written to the public.self_tape_feedback table
// in Supabase (see submitFeedback below) so the team can read it — only the
// "still owe feedback" flag stays local, for gating FeedbackGate.tsx.
import { SELF_TAPES_STORE, withStore, withStoreReadModifyWrite } from "./localDb";
import { supabase } from "./supabase";
import { TAKE_METRICS_COLUMNS, type TakeMetricsRow } from "./takeMetrics";
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
};

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
): Promise<void> {
  const record: TapeRecord = {
    ...meta,
    blob,
    metrics,
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

/** Picks exactly the known self_tape_feedback metric columns off a stored
 * take (see TAKE_METRICS_COLUMNS), so the insert below can't carry some
 * other field that happened to be sitting on `metrics` along with them. */
function pickKnownMetrics(metrics: TakeMetricsRow | undefined): Partial<TakeMetricsRow> | undefined {
  if (!metrics) return undefined;
  return Object.fromEntries(
    TAKE_METRICS_COLUMNS.map((column) => [column, metrics[column]]),
  ) as Partial<TakeMetricsRow>;
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
  const metrics = pickKnownMetrics(existing.metrics);
  let { error } = await supabase.from("self_tape_feedback").insert({ ...feedback, ...metrics });
  // The metrics columns arrive in their own migration
  // (20261008120000_self_tape_feedback_metrics.sql); if a database hasn't had
  // it applied yet, losing the metrics beats losing the feedback, which the
  // beta depends on — so retry with the rating/comment alone.
  if (error && metrics && isMissingColumnError(error)) {
    console.warn("self_tape_feedback metrics columns missing; saving feedback without them:", error);
    ({ error } = await supabase.from("self_tape_feedback").insert(feedback));
  }
  if (error) throw error;

  // Re-read rather than reuse `existing`: the supabase round trip above may
  // have taken a while, and another writer (a delete)
  // could have landed on this record in the meantime. withStoreReadModifyWrite
  // reads and writes in one transaction, so this only ever touches the
  // current record instead of stomping it with a stale snapshot.
  await withStoreReadModifyWrite<TapeRecord>(SELF_TAPES_STORE, id, (current) => ({
    ...current,
    feedbackSubmittedAt: new Date().toISOString(),
  }));
}

/** PostgREST's "column not in the schema cache" (PGRST204) or Postgres's own
 * undefined_column (42703). */
function isMissingColumnError(error: { code?: string }): boolean {
  return error.code === "PGRST204" || error.code === "42703";
}
