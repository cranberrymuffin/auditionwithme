import { useCallback, useRef, useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { useSelfTapeRecorder } from "./useSelfTapeRecorder";
import { stagePendingTape } from "../lib/selfTapeStore";
import { uploadPendingTape } from "../lib/selfTapeUpload";
import { useToast } from "../lib/toast";

/**
 * Owns a rehearsal's self-tape recording end to end: camera/mic capture
 * (via useSelfTapeRecorder) plus handing the finished take off to the
 * account. `finish()` is the single "stop and save" entry point, used both
 * when the script runs out and when the user stops manually.
 */
export function useSelfTapeSession(scriptId: string | null) {
  const { user } = useAuth();
  const { status, stream, error, requestCamera, startRecording, pause, resume, stop } =
    useSelfTapeRecorder();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const statusRef = useRef(status);
  statusRef.current = status;

  /** Stops capture and stages the take in IndexedDB, resolving with its
   * self_tapes id as soon as that local write lands — well before the
   * account upload (kicked off in the background, see selfTapeUpload.ts)
   * finishes. Resolves null if there was nothing to save, or if even local
   * staging failed. Never throws: every step here is guarded so a stop
   * always resolves and the caller can always move on. */
  const finish = useCallback(async (): Promise<string | null> => {
    const hadTake = statusRef.current === "recording" || statusRef.current === "paused";
    setSaving(true);
    try {
      const blob = await stop();
      if (!hadTake) return null;
      if (!blob || blob.size === 0) {
        toast("That take didn't record. Please try again.");
        return null;
      }
      if (!user || !scriptId) return null;

      // Generated client-side so the local record, the eventual upload path,
      // and the eventual row insert can all share the same id.
      const id = crypto.randomUUID();
      // Extension must match the recorded container: Safari (iOS and
      // desktop) records mp4, not webm, and a mismatched extension keeps
      // iOS from recognizing a downloaded file as playable even though the
      // bytes are fine.
      const extension = blob.type.includes("mp4") ? "mp4" : "webm";
      const meta = {
        id,
        userId: user.id,
        scriptId,
        mimeType: blob.type,
        extension,
        createdAt: new Date().toISOString(),
      };

      try {
        await stagePendingTape(meta, blob);
      } catch (stageError) {
        console.error("Failed to stage self-tape locally:", stageError);
        toast("Your self-tape couldn't be saved. Please try again.");
        return null;
      }

      // Fire-and-forget: uploadPendingTape swallows its own errors and
      // leaves the take staged for MyAccount's retry pass rather than
      // rejecting, so this never becomes an unhandled rejection here.
      void uploadPendingTape(meta);
      return id;
    } catch (err) {
      console.error("Self-tape finish() failed unexpectedly:", err);
      toast("Your self-tape couldn't be saved. Please try again.");
      return null;
    } finally {
      setSaving(false);
    }
  }, [stop, user, scriptId, toast]);

  return { user, status, stream, error, saving, requestCamera, startRecording, pause, resume, finish };
}
