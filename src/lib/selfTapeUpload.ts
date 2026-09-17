import { supabase } from "./supabase";
import {
  getPendingTapeBlob,
  listPendingTapes,
  removePendingTape,
  type PendingSelfTape,
} from "./selfTapeStore";
import { notifyAuditionClosed } from "./feedbackGate";

// Pub/sub so MyAccount can swap a "processing" tile for the real, playable
// tape (or leave it staged for the next retry) the moment a background
// upload settles, without polling.
type Listener = (id: string, outcome: "uploaded" | "failed") => void;
const listeners = new Set<Listener>();

export function onTapeUploadSettled(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const inFlight = new Set<string>();

/** Uploads a tape already staged in IndexedDB and inserts its self_tapes
 * row. Never throws — a failure just leaves the blob staged for the next
 * retryPendingTapes() pass instead of losing the take. */
export async function uploadPendingTape(meta: PendingSelfTape): Promise<boolean> {
  if (inFlight.has(meta.id)) return false;
  inFlight.add(meta.id);
  try {
    const blob = await getPendingTapeBlob(meta.id);
    if (!blob) return false;

    const path = `${meta.userId}/${meta.id}.${meta.extension}`;
    // iOS Safari's fetch() can silently mishandle a Blob request body —
    // sending raw bytes instead works around it (see useSelfTapeSession).
    const bytes = await blob.arrayBuffer();
    const { error: uploadError } = await supabase.storage
      .from("self-tapes")
      .upload(path, bytes, { contentType: meta.mimeType });
    if (uploadError) {
      console.error("Background self-tape upload failed:", uploadError.message);
      listeners.forEach((listener) => listener(meta.id, "failed"));
      return false;
    }

    const { error: insertError } = await supabase.from("self_tapes").insert({
      id: meta.id,
      user_id: meta.userId,
      script_id: meta.scriptId,
      storage_path: path,
    });
    if (insertError) {
      console.error("Background self-tape save failed:", insertError.message);
      listeners.forEach((listener) => listener(meta.id, "failed"));
      return false;
    }

    await removePendingTape(meta.id);
    listeners.forEach((listener) => listener(meta.id, "uploaded"));
    // Only now does the self_tapes row actually exist to be queried (and
    // updated by the feedback form) — notifying any earlier, off of local
    // staging alone, can race ahead of this insert and leave FeedbackGate
    // checking for a row that isn't there yet.
    notifyAuditionClosed();
    return true;
  } catch (err) {
    console.error("Background self-tape upload threw:", err);
    listeners.forEach((listener) => listener(meta.id, "failed"));
    return false;
  } finally {
    inFlight.delete(meta.id);
  }
}

/** Resumes takes that finished staging locally but never confirmed their
 * upload — e.g. the tab closed mid-upload, or it failed and is waiting on
 * connectivity. Call on account load and when the app regains a network
 * connection. */
export async function retryPendingTapes(userId: string): Promise<void> {
  let pending: PendingSelfTape[];
  try {
    pending = await listPendingTapes(userId);
  } catch (err) {
    console.error("Failed to read staged self-tapes:", err);
    return;
  }
  for (const meta of pending) void uploadPendingTape(meta);
}
