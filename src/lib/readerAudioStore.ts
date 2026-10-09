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

// iOS Safari can evict a whole origin's storage under pressure, so keep the
// footprint modest: ~50MB is ~300 v3 lines for one script, and 200MB across
// all of them before the least recently generated scripts' audio goes.
export const PER_SCRIPT_CAP_BYTES = 50 * 1024 * 1024;
export const TOTAL_CAP_BYTES = 200 * 1024 * 1024;

type SizedRecord = Pick<ReaderAudioRecord, "cacheKey" | "scriptId" | "size" | "createdAt">;

/**
 * Which records to delete to get under the caps. Within a script over its
 * cap, the oldest lines go first — usually reads from an earlier cast or
 * direction that no current key points at any more. Then, while the total
 * is over its cap, whole scripts go, least recently generated first, never
 * `keepScriptId` (the one being rehearsed). Pure; no IndexedDB.
 */
export function planReaderAudioEviction(
  records: SizedRecord[],
  keepScriptId: string | null,
  caps: { perScript: number; total: number } = {
    perScript: PER_SCRIPT_CAP_BYTES,
    total: TOTAL_CAP_BYTES,
  },
): string[] {
  const evict: string[] = [];
  const byScript = new Map<string, SizedRecord[]>();
  for (const record of records) {
    const list = byScript.get(record.scriptId) ?? [];
    list.push(record);
    byScript.set(record.scriptId, list);
  }
  const scripts: { scriptId: string; bytes: number; newest: string; keys: string[] }[] = [];
  for (const [scriptId, list] of byScript) {
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    let bytes = list.reduce((sum, record) => sum + record.size, 0);
    let first = 0;
    while (bytes > caps.perScript && first < list.length) {
      bytes -= list[first].size;
      evict.push(list[first].cacheKey);
      first += 1;
    }
    const kept = list.slice(first);
    if (kept.length) {
      scripts.push({
        scriptId,
        bytes,
        newest: kept[kept.length - 1].createdAt,
        keys: kept.map((record) => record.cacheKey),
      });
    }
  }
  let total = scripts.reduce((sum, script) => sum + script.bytes, 0);
  scripts.sort((a, b) => a.newest.localeCompare(b.newest));
  for (const script of scripts) {
    if (total <= caps.total) break;
    if (script.scriptId === keepScriptId) continue;
    evict.push(...script.keys);
    total -= script.bytes;
  }
  return evict;
}

/** Applies planReaderAudioEviction to what's stored now. Best-effort: run
 * after pre-generation, and failures are only logged. */
export async function enforceReaderAudioCap(keepScriptId: string | null): Promise<void> {
  const db = await openDb();
  const records = await new Promise<SizedRecord[]>((resolve, reject) => {
    const tx = db.transaction(READER_AUDIO_STORE, "readonly");
    const request = tx.objectStore(READER_AUDIO_STORE).openCursor();
    const found: SizedRecord[] = [];
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve(found);
      const { cacheKey, scriptId, size, createdAt } = cursor.value as ReaderAudioRecord;
      found.push({ cacheKey, scriptId, size, createdAt });
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
  const evict = planReaderAudioEviction(records, keepScriptId);
  if (!evict.length) return;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(READER_AUDIO_STORE, "readwrite");
    const store = tx.objectStore(READER_AUDIO_STORE);
    for (const key of evict) store.delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"));
  });
  console.info(`Evicted ${evict.length} stored reader lines to stay under the storage cap`);
}
