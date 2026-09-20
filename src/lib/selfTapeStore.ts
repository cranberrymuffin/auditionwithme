// Permanent local store for self-tape recordings — replaces the "self-tapes"
// Supabase Storage bucket and self_tapes table. A take is saved here the
// instant recording finishes (see useSelfTapeSession.ts); My Account,
// FeedbackGate, and playback all read straight from IndexedDB, no network
// round trip and no separate upload step.
import { SELF_TAPES_STORE, withStore } from "./localDb";
import type { SelfTape } from "../types";

type TapeRecord = {
  id: string;
  userId: string;
  scriptId: string;
  mimeType: string;
  blob: Blob;
  createdAt: string;
  feedbackRequired: boolean;
  feedbackRating: number | null;
  feedbackComment: string | null;
  feedbackSubmittedAt: string | null;
};

export type NewSelfTape = {
  id: string;
  userId: string;
  scriptId: string;
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
    created_at: record.createdAt,
    feedback_required: record.feedbackRequired,
    feedback_rating: record.feedbackRating,
    feedback_comment: record.feedbackComment,
    feedback_submitted_at: record.feedbackSubmittedAt,
  };
}

export async function saveTape(meta: NewSelfTape, blob: Blob): Promise<void> {
  const record: TapeRecord = {
    ...meta,
    blob,
    createdAt: new Date().toISOString(),
    feedbackRequired: true,
    feedbackRating: null,
    feedbackComment: null,
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
  const updated: TapeRecord = {
    ...existing,
    feedbackRating: rating,
    feedbackComment: comment,
    feedbackSubmittedAt: new Date().toISOString(),
  };
  await withStore(SELF_TAPES_STORE, "readwrite", (store) => store.put(updated));
}
