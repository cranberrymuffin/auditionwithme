import { useCallback, useEffect, useState, type FormEvent } from "react";
import Modal from "./Modal";
import { useAuth } from "../contexts/AuthContext";
import { getPendingFeedbackTape, submitFeedback } from "../lib/selfTapeStore";
import { getSelfTapeUrl } from "../lib/selfTapeUrl";
import { useToast } from "../lib/toast";
import { onAuditionClosed } from "../lib/feedbackGate";
import type { SelfTape } from "../types";

// Beta requirement: a piece of feedback is owed for every audition (self-tape)
// before the user can keep using the app. Mounted once near the root
// (App.tsx) so it blocks on every route, not just My Account — checked
// against the local self-tape store (selfTapeStore.ts), not a server row,
// so clearing site data also clears the gate. That's an acceptable trade for
// a beta feedback nudge, not a security boundary. See src/lib/beta.ts for
// the switch that turns this off.
export default function FeedbackGate() {
  const { user } = useAuth();
  const toast = useToast();
  const [pending, setPending] = useState<SelfTape | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const loadPending = useCallback(async () => {
    if (!user) {
      setPending(null);
      return;
    }
    try {
      setPending(await getPendingFeedbackTape(user.id));
    } catch (err) {
      console.error("Failed to check pending audition feedback:", err);
    }
  }, [user]);

  useEffect(() => {
    void loadPending();
  }, [loadPending]);

  // Rehearsal.tsx fires this the instant a take is saved, so the overlay is
  // already up by the time the user lands on My Account — no refresh needed.
  useEffect(() => onAuditionClosed(() => void loadPending()), [loadPending]);

  // Playback URL for the specific audition this feedback is about — same
  // local-blob-URL pattern as My Account's tape tiles.
  useEffect(() => {
    if (!pending) {
      setVideoUrl(null);
      return;
    }
    let active = true;
    getSelfTapeUrl(pending.id).then((url) => {
      if (active) setVideoUrl(url);
    });
    return () => {
      active = false;
    };
  }, [pending]);

  if (!pending) return null;

  const recordedAt = new Date(pending.created_at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (rating === 0) {
      toast("Pick a star rating before continuing.");
      return;
    }
    if (rating < 5 && !comment.trim()) {
      toast("Let us know what happened before continuing.");
      return;
    }
    setSubmitting(true);
    try {
      await submitFeedback(pending.id, rating, comment.trim() || null);
    } catch (err) {
      console.error("Failed to save audition feedback:", err);
      toast("Couldn't save your feedback. Please try again.");
      setSubmitting(false);
      return;
    }
    setSubmitting(false);
    setRating(0);
    setComment("");
    toast("Thanks for the feedback!", "info");
    void loadPending();
  };

  return (
    <Modal onClose={() => {}} labelledBy="feedback-gate-title">
      <h2 id="feedback-gate-title" className="modal-title">
        How did this audition go?
      </h2>
      <p className="mb-3 text-sm text-ink-soft">
        Recorded {recordedAt}. We're in beta — a quick note after every audition
        helps us fix what's broken before you record another one.
      </p>
      {videoUrl ? (
        <video
          className="feedback-gate-video"
          src={videoUrl}
          controls
          autoPlay
          playsInline
        />
      ) : (
        <div className="feedback-gate-video feedback-gate-video-loading">
          Loading audition…
        </div>
      )}
      <form className="feedback-gate-form" onSubmit={handleSubmit}>
        <div
          className="feedback-gate-stars"
          role="radiogroup"
          aria-label="Rating"
        >
          {[1, 2, 3, 4, 5].map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={rating === value}
              aria-label={`${value} star${value === 1 ? "" : "s"}`}
              className={`feedback-gate-star ${
                value <= rating ? "is-filled" : ""
              }`}
              onClick={() => setRating(value)}
            >
              ★
            </button>
          ))}
        </div>
        <textarea
          className="feedback-gate-textarea"
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          placeholder={
            rating > 0 && rating < 5
              ? "What happened?"
              : "Anything that worked well, felt off, or broke outright?"
          }
          rows={4}
        />
        <button
          type="submit"
          className="feedback-gate-submit"
          disabled={submitting}
        >
          {submitting ? "Saving…" : "Submit feedback"}
        </button>
      </form>
    </Modal>
  );
}
