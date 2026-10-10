// The PDF picked on Home, on its way to /practice. It's kept here rather than
// in router (history) state: browsers serialize history state, may cap its
// size and throw past it, and MDN recommends real storage for anything
// large (https://developer.mozilla.org/en-US/docs/Web/API/History/pushState).
// Only the upload's id travels in history. One slot: stashing a new upload
// replaces the last, so PDFs never pile up on the device.
import { UPLOADS_STORE, openDb, withStore } from "./localDb";

type UploadRecord = { id: string; file: File };

// The same tab's handoff is instant; IndexedDB is the copy a reload (or a
// Back into /practice) reads.
const inMemory = new Map<string, File>();

/** Saves the upload and returns the id to pass to /practice. Resolves even
 * if IndexedDB is unavailable — the in-memory copy still covers this tab. */
export async function stashUpload(file: File): Promise<string> {
  const id = crypto.randomUUID();
  inMemory.clear();
  inMemory.set(id, file);
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(UPLOADS_STORE, "readwrite");
      const store = tx.objectStore(UPLOADS_STORE);
      store.clear();
      store.put({ id, file } satisfies UploadRecord);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
  } catch (err) {
    console.warn("Couldn't keep the upload for a reload:", err);
  }
  return id;
}

/** This tab's copy, if it has one. */
export function peekUpload(id: string): File | null {
  return inMemory.get(id) ?? null;
}

/** The stored copy, or null if it's gone (replaced, cleared, no storage). */
export async function loadUpload(id: string): Promise<File | null> {
  try {
    const record = await withStore<UploadRecord | undefined>(UPLOADS_STORE, "readonly", (store) =>
      store.get(id),
    );
    return record?.file ?? null;
  } catch {
    return null;
  }
}
