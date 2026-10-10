import { useEffect, useState } from "react";
import { listTapeSizes } from "../lib/selfTapeStore";
import { formatBytes, getStorageUsage, type StorageUsage } from "../lib/storageUsage";

// Below this many average-sized takes' worth of room (or this fraction of
// the quota), the meter turns to a warning and suggests clearing old takes.
const LOW_TAKES_LEFT = 5;
const LOW_FRACTION_FREE = 0.1;

/**
 * How much on-device space My Auditions is using and how much is left.
 * `refreshKey` should change whenever something is saved or deleted, so the
 * numbers re-read after a delete instead of showing the old total.
 */
export default function StorageMeter({
  userId,
  refreshKey,
}: {
  userId: string;
  refreshKey: string;
}) {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [averageTapeBytes, setAverageTapeBytes] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    void getStorageUsage(userId).then((next) => {
      if (active) setUsage(next);
    });
    listTapeSizes(userId)
      .then((sizes) => {
        if (!active) return;
        setAverageTapeBytes(
          sizes.length ? sizes.reduce((sum, size) => sum + size, 0) / sizes.length : null,
        );
      })
      .catch((err) => console.warn("Couldn't read self-tape sizes:", err));
    return () => {
      active = false;
    };
  }, [userId, refreshKey]);

  // Browsers without StorageManager: say nothing rather than guess.
  if (!usage) return null;

  const { auditionBytes, freeBytes } = usage;
  // The bar is the actor's own data against the room it could grow into;
  // the app's offline copy is left out of both sides.
  const capacity = auditionBytes + freeBytes;
  const usedFraction = capacity > 0 ? Math.min(1, auditionBytes / capacity) : 0;
  const takesLeft =
    averageTapeBytes && averageTapeBytes > 0
      ? Math.floor(freeBytes / averageTapeBytes)
      : null;
  const low =
    freeBytes / usage.quotaBytes < LOW_FRACTION_FREE ||
    (takesLeft !== null && takesLeft < LOW_TAKES_LEFT);
  // A sliver of a bar still reads as "something's stored".
  const barPercent = auditionBytes > 0 ? Math.max(1.5, usedFraction * 100) : 0;

  return (
    <div className={low ? "storage-meter storage-meter--low" : "storage-meter"}>
      <div className="storage-meter-row">
        <span className="storage-meter-label">Storage on this device</span>
        <span className="storage-meter-free">{formatBytes(freeBytes)} free</span>
      </div>
      <div
        className="storage-meter-track"
        role="meter"
        aria-label="Storage used by your auditions on this device"
        aria-valuemin={0}
        aria-valuemax={capacity}
        aria-valuenow={auditionBytes}
        aria-valuetext={`${formatBytes(auditionBytes)} used, ${formatBytes(freeBytes)} free`}
      >
        <span className="storage-meter-fill" style={{ width: `${barPercent}%` }} />
      </div>
      <p className="storage-meter-detail">
        {formatBytes(auditionBytes)} used by your scripts and takes
        {takesLeft !== null &&
          ` · room for about ${takesLeft.toLocaleString()} more ${takesLeft === 1 ? "take" : "takes"}`}
      </p>
      {low && (
        <p className="storage-meter-warning">
          Running low on space. Download the takes you want to keep, then
          delete them here to make room.
        </p>
      )}
    </div>
  );
}
