import { useEffect, useRef, useState } from "react";
import { useAuth } from "../../contexts/AuthContext";
import { useSelfTapeRecorder } from "../../hooks/useSelfTapeRecorder";
import { supabase } from "../../lib/supabase";
import { useToast } from "../../lib/toast";

export default function SelfTapeRecorder({ scriptId }: { scriptId: string }) {
  const { user } = useAuth();
  const { status, stream, start, stop, error } = useSelfTapeRecorder();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const previewRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (previewRef.current) previewRef.current.srcObject = stream;
  }, [stream]);

  if (!user) return null;

  const save = async () => {
    setSaving(true);
    const blob = await stop();
    if (!blob || blob.size === 0) {
      setSaving(false);
      toast("That take didn't record. Please try again.");
      return;
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
      return;
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
      return;
    }
    toast("Self-tape saved", "info");
  };

  if (!open) {
    return (
      <div className="self-tape-setting">
        <div>
          <strong>Self-tape</strong>
          <span>Record this rehearsal and watch it back from My account.</span>
        </div>
        <button type="button" onClick={() => setOpen(true)}>
          Record self-tape
        </button>
      </div>
    );
  }

  return (
    <div className="self-tape-setting is-open">
      <div>
        <strong>Self-tape</strong>
        <span>
          {status === "recording"
            ? "Recording…"
            : status === "requesting"
              ? "Waiting for camera access…"
              : error ?? "Your camera and mic record while you rehearse."}
        </span>
      </div>
      {stream && (
        <video className="self-tape-preview" ref={previewRef} muted autoPlay playsInline />
      )}
      <div className="self-tape-actions">
        {status === "recording" ? (
          <button type="button" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Stop"}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void start()}
            disabled={status === "requesting"}
          >
            Start
          </button>
        )}
        {status !== "recording" && (
          <button type="button" onClick={() => setOpen(false)}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
