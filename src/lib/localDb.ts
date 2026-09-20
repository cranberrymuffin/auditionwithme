// Shared IndexedDB plumbing for the local scripts/self-tapes stores — see
// scriptStore.ts and selfTapeStore.ts, the two stores this database holds.
// Everything lives on-device now; nothing here ever touches the network.
const DB_NAME = "auditionwithme-local";
const DB_VERSION = 1;

export const SCRIPTS_STORE = "scripts";
export const SELF_TAPES_STORE = "self-tapes";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(SCRIPTS_STORE)) {
          db.createObjectStore(SCRIPTS_STORE, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(SELF_TAPES_STORE)) {
          db.createObjectStore(SELF_TAPES_STORE, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
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
