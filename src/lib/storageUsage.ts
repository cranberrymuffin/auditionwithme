// How much of this browser's on-device storage the app is using, and how
// much is left. Scripts, self-tapes, and reader audio all live in IndexedDB
// (see localDb.ts), so the browser's per-origin quota is the real ceiling on
// how much more an actor can save — not anything on our side.
import {
  READER_AUDIO_STORE,
  SCRIPT_PDFS_STORE,
  SCRIPTS_STORE,
  SELF_TAPES_STORE,
  withStore,
} from "./localDb";

export type StorageUsage = {
  /** Bytes of this user's own scripts, script PDFs, reader audio, and
   * self-tapes — what the actor would think of as "my stuff". */
  auditionBytes: number;
  /** Room left in the origin's quota. The browser's usage figure also
   * counts the app's own offline copy (the PWA precache and image cache),
   * which shares the same quota, so free space comes from that total. */
  freeBytes: number;
  quotaBytes: number;
};

/** Usage for `userId`, or null where the browser doesn't report a quota
 * (StorageManager missing, or an estimate with no quota). */
export async function getStorageUsage(userId: string): Promise<StorageUsage | null> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) return null;
  try {
    const [{ usage, quota }, auditionBytes] = await Promise.all([
      navigator.storage.estimate(),
      getAuditionBytes(userId),
    ]);
    if (!quota) return null;
    return { auditionBytes, freeBytes: Math.max(0, quota - (usage ?? 0)), quotaBytes: quota };
  } catch (err) {
    console.warn("Couldn't estimate storage usage:", err);
    return null;
  }
}

/** Sums the bytes this user's records hold. Blob and File sizes are known
 * without reading their contents, and reader audio stores its size on the
 * record, so this never pulls a video or PDF into memory. */
async function getAuditionBytes(userId: string): Promise<number> {
  const getAll = <T>(storeName: string) =>
    withStore<T[]>(storeName, "readonly", (store) => store.getAll());
  const [scripts, pdfs, audio, tapes] = await Promise.all([
    getAll<{ id: string; userId: string }>(SCRIPTS_STORE),
    getAll<{ scriptId: string; file: File }>(SCRIPT_PDFS_STORE),
    getAll<{ scriptId: string; size: number }>(READER_AUDIO_STORE),
    getAll<{ userId: string; blob: Blob }>(SELF_TAPES_STORE),
  ]);
  const mine = scripts.filter((script) => script.userId === userId);
  const scriptIds = new Set(mine.map((script) => script.id));
  // Script records are plain JSON — a few KB each — so their serialized
  // length is a close enough stand-in for what IndexedDB holds.
  const scriptBytes = mine.reduce((sum, script) => sum + JSON.stringify(script).length, 0);
  const pdfBytes = pdfs
    .filter((record) => scriptIds.has(record.scriptId))
    .reduce((sum, record) => sum + record.file.size, 0);
  const audioBytes = audio
    .filter((record) => scriptIds.has(record.scriptId))
    .reduce((sum, record) => sum + record.size, 0);
  const tapeBytes = tapes
    .filter((record) => record.userId === userId)
    .reduce((sum, record) => sum + record.blob.size, 0);
  return scriptBytes + pdfBytes + audioBytes + tapeBytes;
}

/** "820 KB", "48 MB", "1.3 GB" — decimal units, matching how phones and
 * operating systems report storage. */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = unit >= 3 && value < 10 ? 1 : 0;
  return `${value.toFixed(digits)} ${units[unit]}`;
}
