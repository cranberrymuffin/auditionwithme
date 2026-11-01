// Permanent local store for self-tape recordings — replaces the "self-tapes"
// Supabase Storage bucket and self_tapes table. A take is saved here the
// instant recording finishes (see useSelfTapeSession.ts); My Account,
// FeedbackGate, and playback all read straight from IndexedDB, no network
// round trip and no separate upload step. Audition feedback (rating/comment)
// is the one exception: it's written to the public.self_tape_feedback table
// in Supabase (see submitFeedback below) so the team can read it — only the
// "still owe feedback" flag stays local, for gating FeedbackGate.tsx.
import { SELF_TAPES_STORE, withStore, withStoreReadModifyWrite } from "./localDb";
import { NativeMedia } from "./native/nativeMedia";
import { toBase64 } from "./pcm";
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
  /** The video, for takes recorded in a browser. */
  blob?: Blob;
  /** The video's file on the phone, for takes recorded in the iOS app
   * (NativeMediaPlugin keeps them in Application Support). A take's video
   * is either here or in `blob`, never both. */
  filePath?: string;
  /** The file's size in bytes, alongside `filePath`. */
  size?: number;
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

/** Saves a take recorded natively in the iOS app: its row points at the
 * file instead of holding the video, which never enters the web view. */
export async function saveTapeFile(
  meta: NewSelfTape,
  file: { path: string; size: number },
  metrics?: TakeMetricsRow,
): Promise<void> {
  const record: TapeRecord = {
    ...meta,
    filePath: file.path,
    size: file.size,
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

/** Each of this user's tapes' size in bytes. blob.size is known without
 * reading the video itself, so this stays cheap however long the takes. */
export async function listTapeSizes(userId: string): Promise<number[]> {
  const all = await withStore<TapeRecord[]>(SELF_TAPES_STORE, "readonly", (store) =>
    store.getAll(),
  );
  return all
    .filter((record) => record.userId === userId)
    .map((record) => record.blob?.size ?? record.size ?? 0);
}

export async function getTapeBlob(id: string): Promise<Blob | null> {
  const record = await withStore<TapeRecord | undefined>(
    SELF_TAPES_STORE,
    "readonly",
    (store) => store.get(id),
  );
  return record?.blob ?? null;
}

/** A natively recorded take's file, or null for a browser take (or none). */
export async function getTapeFile(id: string): Promise<{ path: string; size: number; mimeType: string } | null> {
  const record = await withStore<TapeRecord | undefined>(
    SELF_TAPES_STORE,
    "readonly",
    (store) => store.get(id),
  );
  return record?.filePath ? { path: record.filePath, size: record.size ?? 0, mimeType: record.mimeType } : null;
}

/**
 * iOS app only: moves a take recorded in the web view before native
 * recording (a Blob in IndexedDB, which WKWebView often can't read back)
 * into a file, and points the row at it. Resolves the file, or null if the
 * Blob couldn't be read — that take can't be recovered.
 */
export async function moveTapeBlobToFile(id: string): Promise<{ path: string; size: number; mimeType: string } | null> {
  const record = await withStore<TapeRecord | undefined>(
    SELF_TAPES_STORE,
    "readonly",
    (store) => store.get(id),
  );
  if (!record?.blob) return null;
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await record.blob.arrayBuffer());
  } catch (err) {
    console.warn(`Self-tape ${id} couldn't be read back:`, err);
    return null;
  }
  const file = await NativeMedia.storeTakeFile({
    tapeId: id,
    base64: toBase64(bytes),
    extension: extensionForMimeType(record.mimeType),
  });
  await withStore(SELF_TAPES_STORE, "readwrite", (store) =>
    store.put({ ...record, blob: undefined, filePath: file.path, size: file.size }),
  );
  return { path: file.path, size: file.size, mimeType: record.mimeType };
}

export async function deleteTape(id: string): Promise<void> {
  const file = await getTapeFile(id);
  await withStore(SELF_TAPES_STORE, "readwrite", (store) => store.delete(id));
  if (file) await NativeMedia.deleteTakeFile({ path: file.path });
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
