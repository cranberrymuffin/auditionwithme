import { useCallback, useRef, useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { useSelfTapeRecorder } from "./useSelfTapeRecorder";
import { extensionForMimeType, saveTape, saveTapeFile } from "../lib/selfTapeStore";
import { NativeMedia } from "../lib/native/nativeMedia";
import { deviceClass, type TakeMetrics } from "../lib/takeMetrics";
import { notifyAuditionClosed } from "../lib/feedbackGate";
import { useToast } from "../lib/toast";

/**
 * Owns a rehearsal's self-tape recording end to end: camera/mic capture
 * (via useSelfTapeRecorder) plus handing the finished take off to the
 * account. `finish()` is the single "stop and save" entry point, used both
 * when the script runs out and when the user stops manually.
 */
export function useSelfTapeSession(scriptId: string | null, role: string) {
  const { user } = useAuth();
  const { status, stream, error, cameraInterrupted, zoom, setZoom, requestCamera, switchDevice, startRecording, pause, resume, stop, videoSize, nativePreview } =
    useSelfTapeRecorder();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const statusRef = useRef(status);
  statusRef.current = status;

  /** Stops capture and saves the take straight to the local store, resolving
   * with its id once that write lands — no upload, no network round trip.
   * Resolves null if there was nothing to save, or if the save itself
   * failed. Never throws: every step here is guarded so a stop always
   * resolves and the caller can always move on. `metrics` (the take's
   * rehearsal telemetry) is saved with the take and sent along with its
   * feedback later. */
  const finish = useCallback(async (metrics?: TakeMetrics): Promise<string | null> => {
    const hadTake = statusRef.current === "recording" || statusRef.current === "paused";
    setSaving(true);
    try {
      // Read before stop(), which ends the camera track (web); the native
      // recorder reports its camera's size itself.
      const video = videoSize ?? stream?.getVideoTracks()[0]?.getSettings();
      const take = await stop();
      if (!hadTake) return null;
      if (!take || take.size === 0) {
        toast("That take didn't record. Please try again.");
        return null;
      }
      if (!user || !scriptId) return null;

      const id = crypto.randomUUID();
      try {
        const metricsRow = metrics?.toRow({
          deviceClass: deviceClass(),
          videoWidth: video?.width ?? null,
          videoHeight: video?.height ?? null,
        });
        if (take instanceof Blob) {
          await saveTape({ id, userId: user.id, scriptId, role, mimeType: take.type }, take, metricsRow);
        } else {
          // Moved from the temp folder to where takes are kept, under the
          // name the share sheet will save it as.
          const kept = await NativeMedia.keepTake({
            path: take.path,
            tapeId: id,
            fileName: `self-tape-${new Date().toISOString().slice(0, 10)}-${id.slice(0, 8)}.${extensionForMimeType(take.mimeType)}`,
          });
          await saveTapeFile({ id, userId: user.id, scriptId, role, mimeType: take.mimeType }, kept, metricsRow);
        }
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
  }, [stop, stream, videoSize, user, scriptId, role, toast]);

  return { user, status, stream, error, cameraInterrupted, zoom, setZoom, saving, requestCamera, switchDevice, startRecording, pause, resume, finish, nativePreview };
}
