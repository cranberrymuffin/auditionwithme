// Shared IndexedDB plumbing for the local stores — see scriptStore.ts,
// selfTapeStore.ts, and readerAudioStore.ts, the three stores this database
// holds. Everything lives on-device now; nothing here ever touches the network.
const DB_NAME = "auditionwithme-local";
// v2 adds the reader-audio store (pre-generated scene-partner lines).
const DB_VERSION = 2;

export const SCRIPTS_STORE = "scripts";
export const SELF_TAPES_STORE = "self-tapes";
export const READER_AUDIO_STORE = "reader-audio";

// How long an upgrade may sit blocked behind another tab still holding the
// old version open before callers give up on the database for now (they fall
// back — reader audio to a live fetch — rather than hang).
const BLOCKED_TIMEOUT_MS = 3000;

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    const attempt: Promise<IDBDatabase> = new Promise((resolve, reject) => {
      let gaveUp = false;
      let blockedTimer: ReturnType<typeof setTimeout> | null = null;
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(SCRIPTS_STORE)) {
          db.createObjectStore(SCRIPTS_STORE, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(SELF_TAPES_STORE)) {
          db.createObjectStore(SELF_TAPES_STORE, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(READER_AUDIO_STORE)) {
          const store = db.createObjectStore(READER_AUDIO_STORE, { keyPath: "cacheKey" });
          // Lets a script's audio be found (and evicted) without a full scan.
          store.createIndex("scriptId", "scriptId", { unique: false });
        }
      };
      // Another tab still has the old version open and isn't letting go.
      // Don't wait forever: reject and clear the singleton so a later call
      // retries once that tab closes or reloads.
      request.onblocked = () => {
        console.warn("IndexedDB upgrade blocked by another tab");
        if (blockedTimer) return;
        blockedTimer = setTimeout(() => {
          gaveUp = true;
          if (dbPromise === attempt) dbPromise = null;
          reject(new Error("IndexedDB upgrade blocked"));
        }, BLOCKED_TIMEOUT_MS);
      };
      request.onsuccess = () => {
        if (blockedTimer) clearTimeout(blockedTimer);
        const db = request.result;
        // Opened after we already gave up: nobody holds this handle, so
        // release it instead of leaking a connection that blocks the next
        // upgrade.
        if (gaveUp) {
          db.close();
          return;
        }
        // When *this* tab is the old one and another opens a newer version,
        // step aside so its upgrade isn't blocked; the next call reopens.
        db.onversionchange = () => {
          db.close();
          if (dbPromise === attempt) dbPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        if (blockedTimer) clearTimeout(blockedTimer);
        if (dbPromise === attempt) dbPromise = null;
        reject(request.error);
      };
    });
    dbPromise = attempt;
  }
  return dbPromise;
}

export async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const request = run(tx.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
