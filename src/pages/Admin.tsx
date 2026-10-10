import { useEffect, useMemo, useState } from "react";
import Seo from "../components/Seo";
import SiteNav from "../components/SiteNav";
import { apiFetch } from "../lib/api";
import { throwIfError } from "../lib/apiError";

type AdminUser = {
  id: string;
  email: string | null;
  created_at: string;
  last_sign_in_at: string | null;
  email_confirmed_at: string | null;
  is_admin: boolean;
  subscription_status: string | null;
  free_sessions_used: number | null;
  nda_accepted_at: string | null;
};

/** A self_tape_feedback row — see supabase/migrations/*_self_tape_feedback_*.sql.
 * Metrics columns are null on takes recorded before they shipped. */
type Feedback = {
  id: string;
  user_id: string;
  tape_id: string;
  script_id: string;
  rating: number;
  comment: string | null;
  recorded_at: string;
  submitted_at: string;
  reader_latency_ms_p50?: number | null;
  reader_latency_ms_max?: number | null;
  lines_auto_detected?: number | null;
  lines_manual_next?: number | null;
  lines_semantic_advanced?: number | null;
  lines_silence_advanced?: number | null;
  lines_backtracked_after_auto?: number | null;
  device_class?: string | null;
  video_width?: number | null;
  video_height?: number | null;
};

type Overview = { users: AdminUser[]; feedback: Feedback[] };

type Tab = "users" | "feedback";

function formatDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function averageRating(rows: Feedback[]) {
  if (rows.length === 0) return null;
  return rows.reduce((sum, row) => sum + row.rating, 0) / rows.length;
}

export default function Admin() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("users");
  const [query, setQuery] = useState("");
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    apiFetch("/api/admin")
      .then(async (res) => {
        await throwIfError(res, "Could not load admin data");
        return (await res.json()) as Overview;
      })
      .then((data) => {
        if (active) setOverview(data);
      })
      .catch((err: Error) => {
        if (active) setError(err.message);
      });
    return () => {
      active = false;
    };
  }, []);

  const feedbackByUser = useMemo(() => {
    const map = new Map<string, Feedback[]>();
    for (const row of overview?.feedback ?? []) {
      const rows = map.get(row.user_id) ?? [];
      rows.push(row);
      map.set(row.user_id, rows);
    }
    return map;
  }, [overview]);

  const emailById = useMemo(
    () => new Map((overview?.users ?? []).map((user) => [user.id, user.email])),
    [overview],
  );

  const needle = query.trim().toLowerCase();

  // Newest signups first; the search box matches on email.
  const users = useMemo(
    () =>
      (overview?.users ?? [])
        .filter((user) => !needle || (user.email ?? "").toLowerCase().includes(needle))
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [overview, needle],
  );

  // Already newest first from the API; the search box matches on the
  // author's email or the comment text.
  const feedback = useMemo(
    () =>
      (overview?.feedback ?? []).filter(
        (row) =>
          !needle ||
          (emailById.get(row.user_id) ?? "").toLowerCase().includes(needle) ||
          (row.comment ?? "").toLowerCase().includes(needle),
      ),
    [overview, emailById, needle],
  );

  const overallAverage = averageRating(overview?.feedback ?? []);

  return (
    <main className="account-page">
      <Seo title="Admin" description="Users and audition feedback." path="/admin" noindex />
      <SiteNav />

      <section className="account-main admin-main">
        <header className="account-header">
          <p className="eyebrow">Admin</p>
          <h1>Users &amp; feedback</h1>
        </header>

        {error && (
          <p className="admin-error" role="alert">
            {error}
          </p>
        )}

        {!overview && !error && (
          <p className="account-subtitle" aria-busy="true">
            Loading…
          </p>
        )}

        {overview && (
          <>
            <dl className="admin-stats">
              <div>
                <dt>Users</dt>
                <dd>{overview.users.length}</dd>
              </div>
              <div>
                <dt>Feedback</dt>
                <dd>{overview.feedback.length}</dd>
              </div>
              <div>
                <dt>Avg rating</dt>
                <dd>{overallAverage === null ? "—" : overallAverage.toFixed(2)}</dd>
              </div>
            </dl>

            <div className="admin-toolbar">
              <div className="admin-tabs" role="tablist" aria-label="Admin views">
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "users"}
                  className={`admin-tab ${tab === "users" ? "is-active" : ""}`}
                  onClick={() => setTab("users")}
                >
                  Users
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "feedback"}
                  className={`admin-tab ${tab === "feedback" ? "is-active" : ""}`}
                  onClick={() => setTab("feedback")}
                >
                  All feedback
                </button>
              </div>
              <input
                type="search"
                className="admin-search"
                placeholder={tab === "users" ? "Search by email" : "Search email or comment"}
                aria-label="Search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>

            {tab === "users" ? (
              <ul className="admin-list">
                {users.length === 0 && <li className="admin-empty">No matching users.</li>}
                {users.map((user) => {
                  const rows = feedbackByUser.get(user.id) ?? [];
                  const average = averageRating(rows);
                  const expanded = expandedUserId === user.id;
                  return (
                    <li key={user.id} className="admin-user">
                      <button
                        type="button"
                        className="admin-user-summary"
                        aria-expanded={expanded}
                        onClick={() => setExpandedUserId(expanded ? null : user.id)}
                      >
                        <span className="admin-user-email">
                          {user.email ?? user.id}
                          {user.is_admin && <span className="admin-badge">Admin</span>}
                          {!user.email_confirmed_at && (
                            <span className="admin-badge admin-badge--muted">Unconfirmed</span>
                          )}
                          {!user.nda_accepted_at && (
                            <span className="admin-badge admin-badge--muted">No NDA</span>
                          )}
                        </span>
                        <span className="admin-user-meta">
                          Joined {formatDate(user.created_at)} · Last sign-in{" "}
                          {formatDate(user.last_sign_in_at)}
                        </span>
                        <span className="admin-user-meta">
                          {rows.length} feedback
                          {average !== null && ` · avg ${average.toFixed(1)}★`}
                          {user.free_sessions_used !== null &&
                            ` · ${user.free_sessions_used} sessions`}
                          {user.subscription_status && ` · ${user.subscription_status}`}
                        </span>
                      </button>
                      {expanded && (
                        <div className="admin-user-feedback">
                          {rows.length === 0 ? (
                            <p className="admin-empty">No feedback yet.</p>
                          ) : (
                            <ul className="admin-list">
                              {rows.map((row) => (
                                <FeedbackItem key={row.id} feedback={row} />
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <ul className="admin-list">
                {feedback.length === 0 && <li className="admin-empty">No matching feedback.</li>}
                {feedback.map((row) => (
                  <FeedbackItem
                    key={row.id}
                    feedback={row}
                    email={emailById.get(row.user_id) ?? row.user_id}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </section>
    </main>
  );
}

function FeedbackItem({ feedback, email }: { feedback: Feedback; email?: string | null }) {
  const metrics = [
    feedback.device_class,
    feedback.reader_latency_ms_p50 != null &&
      `reader latency p50 ${feedback.reader_latency_ms_p50}ms / max ${feedback.reader_latency_ms_max ?? "—"}ms`,
    feedback.lines_auto_detected != null && `${feedback.lines_auto_detected} auto`,
    feedback.lines_manual_next != null && `${feedback.lines_manual_next} manual`,
    feedback.lines_semantic_advanced != null && `${feedback.lines_semantic_advanced} semantic`,
    feedback.lines_silence_advanced != null && `${feedback.lines_silence_advanced} silence`,
    feedback.lines_backtracked_after_auto != null &&
      `${feedback.lines_backtracked_after_auto} backtracked`,
    feedback.video_width != null &&
      feedback.video_height != null &&
      `${feedback.video_width}×${feedback.video_height}`,
  ].filter(Boolean);

  return (
    <li className="admin-feedback">
      <div className="admin-feedback-head">
        <span className="admin-rating" aria-label={`${feedback.rating} out of 5 stars`}>
          {"★".repeat(feedback.rating)}
          <span className="admin-rating-empty">{"★".repeat(5 - feedback.rating)}</span>
        </span>
        {email && <span className="admin-feedback-email">{email}</span>}
        <span className="admin-user-meta">{formatDate(feedback.submitted_at)}</span>
      </div>
      {feedback.comment ? (
        <p className="admin-feedback-comment">{feedback.comment}</p>
      ) : (
        <p className="admin-feedback-comment admin-feedback-comment--empty">No comment</p>
      )}
      {metrics.length > 0 && <p className="admin-user-meta">{metrics.join(" · ")}</p>}
    </li>
  );
}
