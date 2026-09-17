// Local staging for self-tapes. A finished recording lands here the instant
// it's captured (an IndexedDB write, no network) so the rehearsal flow can
// hand off and move on immediately instead of blocking on the Supabase
// upload. selfTapeUpload.ts drains this store in the background and clears
// an entry once its self_tapes row is confirmed saved — see that file for
// the upload/retry logic that consumes what's staged here.
const DB_NAME = "self-tape-staging";
const DB_VERSION = 1;
const STORE = "pending-tapes";

export type PendingSelfTape = {
  id: string;
  userId: string;
  scriptId: string;
  mimeType: string;
  extension: string;
  createdAt: string;
};

type StoredRecord = PendingSelfTape & { blob: Blob };

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function stagePendingTape(meta: PendingSelfTape, blob: Blob): Promise<void> {
  const record: StoredRecord = { ...meta, blob };
  await withStore("readwrite", (store) => store.put(record));
}

export async function listPendingTapes(userId: string): Promise<PendingSelfTape[]> {
  const records = await withStore<StoredRecord[]>("readonly", (store) => store.getAll());
  return records
    .filter((record) => record.userId === userId)
    .map(({ id, userId, scriptId, mimeType, extension, createdAt }) => ({
      id,
      userId,
      scriptId,
      mimeType,
      extension,
      createdAt,
    }));
}

export async function getPendingTapeBlob(id: string): Promise<Blob | null> {
  const record = await withStore<StoredRecord | undefined>("readonly", (store) => store.get(id));
  return record?.blob ?? null;
}

export async function removePendingTape(id: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(id));
}
