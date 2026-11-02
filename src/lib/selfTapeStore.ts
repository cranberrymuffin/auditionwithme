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
import { NativeMedia } from "./native/nativeMedia";

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
  /** The video file's name in the app's tapes folder, for takes recorded
   * in the iOS app. A name, not a path: the folder's full path changes when
   * iOS moves the app's data container (reinstall, update). A take's video
   * is in `blob` or a file, never both. */
  fileName?: string;
  /** Rows saved before `fileName`: the file's full path at the time. Only
   * its name is used now, for the same reason. */
  filePath?: string;
  /** The file's size in bytes, alongside the file. */
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

/** Saves a take recorded natively in the iOS app: the row points at the
 * file, and the video never enters the web view. */
export async function saveTapeFile(
  meta: NewSelfTape,
  file: { path: string; size: number },
  metrics?: TakeMetricsRow,
): Promise<void> {
  const record: TapeRecord = {
    ...meta,
    fileName: file.path.split("/").pop(),
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

let tapesDir: Promise<string> | null = null;

/** A natively recorded take's file, resolved against the tapes folder's
 * current path, or null for a browser take (or none). */
export async function getTapeFile(id: string): Promise<{ path: string; mimeType: string } | null> {
  const record = await withStore<TapeRecord | undefined>(
    SELF_TAPES_STORE,
    "readonly",
    (store) => store.get(id),
  );
  const name = record?.fileName ?? record?.filePath?.split("/").pop();
  if (!record || !name) return null;
  tapesDir ??= NativeMedia.getTapesDir().then(
    ({ path }) => path,
    (err) => {
      tapesDir = null; // try again next time
      throw err;
    },
  );
  return { path: `${await tapesDir}/${name}`, mimeType: record.mimeType };
}

export async function deleteTape(id: string): Promise<void> {
  // A native take's video is a file of its own; remove it with the row.
  const file = await getTapeFile(id).catch(() => null);
  await withStore(SELF_TAPES_STORE, "readwrite", (store) => store.delete(id));
  if (file) await NativeMedia.deleteTakeFile({ path: file.path }).catch(() => {});
}

// A file this new may belong to a take whose row is still being saved
// (keepTake moves the file, then saveTapeFile writes the row).
const ORPHAN_MIN_AGE_MS = 10 * 60 * 1000;

/** iOS app only: deletes files in the tapes folder that no take points at —
 * left behind when a take's row failed to save after its file was kept.
 * Checks every user's rows, since they share the device's tapes folder.
 * Returns the bytes freed. */
export async function pruneOrphanTakeFiles(): Promise<number> {
  const [records, { files }, dir] = await Promise.all([
    withStore<TapeRecord[]>(SELF_TAPES_STORE, "readonly", (store) => store.getAll()),
    NativeMedia.listTakeFiles(),
    NativeMedia.getTapesDir(),
  ]);
  const referenced = new Set(
    records.map((record) => record.fileName ?? record.filePath?.split("/").pop()).filter(Boolean),
  );
  // The rows are the only thing vouching for a file, and they live in the web
  // view's storage, which iOS can wipe when the phone is low on space. If no
  // row points at any file here, that's far likelier to be lost rows than a
  // folder of leftovers — and deleting would take every video with them.
  if (!files.some((file) => referenced.has(file.name))) return 0;
  const cutoff = Date.now() - ORPHAN_MIN_AGE_MS;
  const orphans = files.filter((file) => !referenced.has(file.name) && file.modifiedAt < cutoff);
  await Promise.all(
    orphans.map((file) => NativeMedia.deleteTakeFile({ path: `${dir.path}/${file.name}` }).catch(() => {})),
  );
  if (orphans.length) console.info(`Deleted ${orphans.length} take files no take pointed at`);
  return orphans.reduce((sum, file) => sum + file.size, 0);
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
