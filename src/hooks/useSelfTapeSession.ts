import { useCallback, useRef, useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { useSelfTapeRecorder } from "./useSelfTapeRecorder";
import { supabase } from "../lib/supabase";
import { useToast } from "../lib/toast";

/**
 * Owns a rehearsal's self-tape recording end to end: camera/mic capture
 * (via useSelfTapeRecorder) plus uploading the finished take to the user's
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

  /** Stops capture, uploads the take, and resolves with its self_tapes row
   * id — or null if there was nothing to save or saving failed. */
  const finish = useCallback(async (): Promise<string | null> => {
    const hadTake = statusRef.current === "recording" || statusRef.current === "paused";
    setSaving(true);
    const blob = await stop();
    if (!hadTake) {
      setSaving(false);
      return null;
    }
    if (!blob || blob.size === 0) {
      setSaving(false);
      toast("That take didn't record. Please try again.");
      return null;
    }
    if (!user || !scriptId) {
      setSaving(false);
      return null;
    }

    // Generated client-side so the upload path and the row insert can share
    // the same id without a round trip in between.
    const id = crypto.randomUUID();
    const path = `${user.id}/${id}.webm`;
    const { error: uploadError } = await supabase.storage
      .from("self-tapes")
      .upload(path, blob, { contentType: blob.type });
    if (uploadError) {
      console.error("Failed to upload self-tape:", uploadError.message);
      setSaving(false);
      toast("Your self-tape couldn't be saved. Please try again.");
      return null;
    }

    const { error: insertError } = await supabase.from("self_tapes").insert({
      id,
      user_id: user.id,
      script_id: scriptId,
      storage_path: path,
    });
    setSaving(false);
    if (insertError) {
      console.error("Failed to save self-tape to account:", insertError.message);
      toast("Your self-tape couldn't be saved. Please try again.");
      return null;
    }
    toast("Self-tape saved", "info");
    return id;
  }, [stop, user, scriptId, toast]);

  return { user, status, stream, error, saving, requestCamera, startRecording, pause, resume, finish };
}
