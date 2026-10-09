// Pre-generated scene-partner audio, kept on-device so a reload, a Recast
// with unchanged voices, or a second take never re-bills ElevenLabs or waits
// on the network. Keyed by the same cacheKey the player's in-memory cache
// uses (cacheKey in useTtsPlayer.ts), so a changed voice or direction is a
// different key. Every call here is best-effort: callers treat a failure as
// a cache miss and fall back to a live fetch.
import { openDb, READER_AUDIO_STORE, withStore } from "./localDb";

export type ReaderAudioRecord = {
  cacheKey: string;
  scriptId: string;
  blob: Blob;
  /** blob.size, stored so size accounting never has to touch the blob. */
  size: number;
  createdAt: string;
};

export async function loadReaderAudio(cacheKey: string): Promise<Blob | null> {
  const record = await withStore<ReaderAudioRecord | undefined>(
    READER_AUDIO_STORE,
    "readonly",
    (store) => store.get(cacheKey),
  );
  return record?.blob ?? null;
}

export async function saveReaderAudio(
  cacheKey: string,
  scriptId: string,
  blob: Blob,
): Promise<void> {
  const record: ReaderAudioRecord = {
    cacheKey,
    scriptId,
    blob,
    size: blob.size,
    createdAt: new Date().toISOString(),
  };
  await withStore(READER_AUDIO_STORE, "readwrite", (store) => store.put(record));
}

/**
 * Deletes every record whose `indexName` index equals `key`, returning how
 * many went. withStore resolves on its request's first onsuccess, so it can't
 * walk a cursor; this runs its own transaction and resolves only once the
 * cursor is exhausted and the transaction has committed.
 */
export async function deleteByIndex(
  storeName: string,
  indexName: string,
  key: IDBValidKey,
): Promise<number> {
  const db = await openDb();
  return new Promise<number>((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const request = tx.objectStore(storeName).index(indexName).openCursor(IDBKeyRange.only(key));
    let deleted = 0;
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return; // done; tx.oncomplete resolves
      cursor.delete();
      deleted += 1;
      cursor.continue();
    };
    tx.oncomplete = () => resolve(deleted);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"));
  });
}

export function deleteReaderAudioForScript(scriptId: string): Promise<number> {
  return deleteByIndex(READER_AUDIO_STORE, "scriptId", scriptId);
}
