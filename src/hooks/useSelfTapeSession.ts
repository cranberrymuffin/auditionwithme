import { useCallback, useRef, useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { useSelfTapeRecorder } from "./useSelfTapeRecorder";
import { saveTape } from "../lib/selfTapeStore";
import { notifyAuditionClosed } from "../lib/feedbackGate";
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

  /** Stops capture and saves the take straight to the local store, resolving
   * with its id once that write lands — no upload, no network round trip.
   * Resolves null if there was nothing to save, or if the save itself
   * failed. Never throws: every step here is guarded so a stop always
   * resolves and the caller can always move on. */
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

      const id = crypto.randomUUID();
      try {
        await saveTape({ id, userId: user.id, scriptId, mimeType: blob.type }, blob);
      } catch (saveError) {
        console.error("Failed to save self-tape locally:", saveError);
        toast("Your self-tape couldn't be saved. Please try again.");
        return null;
      }

      // Beta: a saved audition owes feedback — see FeedbackGate.tsx, mounted
      // at the app root, and src/lib/beta.ts for the flag that turns it off.
      notifyAuditionClosed();
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
