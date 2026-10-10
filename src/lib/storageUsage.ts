// How much of this browser's on-device storage the app is using, and how
// much is left. Scripts, self-tapes, and reader audio all live in IndexedDB
// (see localDb.ts), so the browser's per-origin quota is the real ceiling on
// how much more an actor can save — not anything on our side.

export type StorageUsage = {
  usedBytes: number;
  quotaBytes: number;
};

/** The origin's usage and quota, or null where the browser doesn't report
 * them (StorageManager missing, or an estimate with no quota). */
export async function getStorageUsage(): Promise<StorageUsage | null> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    if (!quota) return null;
    return { usedBytes: usage ?? 0, quotaBytes: quota };
  } catch (err) {
    console.warn("Couldn't estimate storage usage:", err);
    return null;
  }
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
