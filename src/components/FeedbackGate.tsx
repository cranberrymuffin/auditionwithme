import { useCallback, useEffect, useState, type FormEvent } from "react";
import Modal from "./Modal";
import { useAuth } from "../contexts/AuthContext";
import { getPendingFeedbackTape, skipFeedback, submitFeedback } from "../lib/selfTapeStore";
import { getSelfTapeUrl } from "../lib/selfTapeUrl";
import { useToast } from "../lib/toast";
import { notifyFeedbackOwedChanged, onFeedbackGateRequested, onFeedbackOwedChanged } from "../lib/feedbackGate";
import { displayCharacterName } from "../lib/script";
import type { SelfTape } from "../types";

// Beta: every saved take asks for a rating before the next one is recorded.
// Mounted once near the root (App.tsx) so it shows wherever the actor lands
// after a take. It can be put off ("Not now") or skipped for a test take;
// what it blocks is recording another take (Rehearsal.tsx, via
// useFeedbackOwed), not the rest of the app. Checked against the local
// self-tape store (selfTapeStore.ts), not a server row, so clearing site data
// also clears it: a feedback nudge, not a security boundary. See
// src/lib/beta.ts for the switch that turns this off.
const COMMENT_MAX_LENGTH = 5000; // enforced by the database too
export default function FeedbackGate() {
  const { user } = useAuth();
  const toast = useToast();
  const [pending, setPending] = useState<SelfTape | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [problem, setProblem] = useState(false);
  // "Not now" for this take, until the actor tries to record another (or
  // reloads): a tape id, so a newer pending take shows the gate again.
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  // Reopened by a blocked Start, so the copy can say why.
  const [requested, setRequested] = useState(false);

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

  // Fired the instant a take is saved, so the overlay is already up by the
  // time the user lands on My Account — no refresh needed.
  useEffect(() => onFeedbackOwedChanged(() => void loadPending()), [loadPending]);

  useEffect(() => onFeedbackGateRequested(() => {
    setDismissedId(null);
    setRequested(true);
  }), []);

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

  if (!pending || pending.id === dismissedId) return null;

  const recordedAt = new Date(pending.created_at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  const reset = () => {
    setRating(0);
    setComment("");
    setProblem(false);
    setRequested(false);
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (rating === 0) {
      setProblem(true);
      return;
    }
    setProblem(false);
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
    reset();
    toast("Thanks for the feedback!", "success");
    notifyFeedbackOwedChanged();
  };

  const handleSkip = async () => {
    setSubmitting(true);
    try {
      await skipFeedback(pending.id);
    } catch (err) {
      console.error("Failed to skip audition feedback:", err);
      toast("Couldn't skip that just now. Please try again.");
      setSubmitting(false);
      return;
    }
    setSubmitting(false);
    reset();
    notifyFeedbackOwedChanged();
  };

  const handleNotNow = () => {
    setRequested(false);
    setDismissedId(pending.id);
  };

  const lowRating = rating > 0 && rating < 5;

  return (
    <Modal onClose={handleNotNow} labelledBy="feedback-gate-title" className="feedback-gate">
      <h2 id="feedback-gate-title" className="modal-title">
        How did this take go?
      </h2>
      <p className="feedback-gate-slate">
        Recorded {recordedAt}
        {pending.role && <> as {displayCharacterName(pending.role)}</>}
      </p>
      <p className="modal-copy feedback-gate-intro">
        {requested
          ? "Rate this take, or skip it, and you can record the next one."
          : "We’re in beta, so a quick rating after each take helps us fix what’s broken. You’ll need to rate or skip this one before recording another."}
      </p>
      {videoUrl ? (
        // No autoplay: the actor may be somewhere their take shouldn't blare
        // out. The fragment makes Safari paint a first frame as the poster.
        <video
          className="feedback-gate-video"
          src={`${videoUrl}#t=0.001`}
          controls
          playsInline
          preload="metadata"
          aria-label="Your take"
        />
      ) : (
        <div className="feedback-gate-video feedback-gate-video-loading">
          Loading your take…
        </div>
      )}
      <form className="feedback-gate-form" onSubmit={handleSubmit}>
        <div className="feedback-gate-rating">
          <div
            className="feedback-gate-stars"
            role="radiogroup"
            aria-label="Rating"
            aria-describedby={problem ? "feedback-gate-problem" : undefined}
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
                data-autofocus={value === 1 ? true : undefined}
                onClick={() => {
                  setRating(value);
                  setProblem(false);
                }}
              >
                ★
              </button>
            ))}
          </div>
          <span className="feedback-gate-rating-label" aria-hidden="true">
            {["Tap to rate", "Didn’t work", "Rough", "Okay", "Good", "Great"][rating]}
          </span>
        </div>
        {problem && (
          <p id="feedback-gate-problem" className="field-error feedback-gate-problem" role="alert">
            Pick a star rating to send feedback, or skip this take below.
          </p>
        )}
        <label className="field-label feedback-gate-label" htmlFor="feedback-gate-comment">
          {lowRating ? "What could have gone better?" : "Anything to add?"}{" "}
          <span>(optional)</span>
        </label>
        <textarea
          id="feedback-gate-comment"
          className="textarea feedback-gate-textarea"
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          placeholder={
            lowRating
              ? "Even a few words help: what felt off, was slow, or broke?"
              : "Anything that worked well, felt off, or broke outright?"
          }
          maxLength={COMMENT_MAX_LENGTH}
          rows={3}
        />
        <button
          type="submit"
          className="btn-primary btn-lg btn-block feedback-gate-submit"
          disabled={submitting}
        >
          {submitting ? "Saving…" : "Send feedback"}
        </button>
        <div className="feedback-gate-secondary">
          <button type="button" className="btn-ghost" onClick={() => void handleSkip()} disabled={submitting}>
            This was just a test — skip
          </button>
          <button type="button" className="btn-ghost" onClick={handleNotNow} disabled={submitting}>
            Not now
          </button>
        </div>
      </form>
    </Modal>
  );
}
