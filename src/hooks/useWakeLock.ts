import { useEffect } from "react";

/**
 * Keeps the screen from sleeping while `active`. Without this, a phone's
 * auto-lock timer can turn the screen off mid self-tape — which suspends
 * camera/mic capture and can silently lose the take. Wake Lock isn't
 * supported everywhere (older iOS Safari in particular), so this degrades
 * to a no-op there rather than failing the rehearsal.
 */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || !("wakeLock" in navigator)) return;

    let lock: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = async () => {
      try {
        const sentinel = await navigator.wakeLock.request("screen");
        if (cancelled) {
          void sentinel.release();
          return;
        }
        lock = sentinel;
      } catch {
        // Permission/OS-state failures are non-fatal — the rehearsal just
        // proceeds without the lock, same as on an unsupported browser.
      }
    };

    // The lock is released automatically when the tab is backgrounded, and
    // Safari/Chrome don't re-acquire it on their own when it comes back.
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible" && !lock) void acquire();
    };

    void acquire();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      void lock?.release();
    };
  }, [active]);
}
