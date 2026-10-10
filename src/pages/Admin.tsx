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

const DAY_MS = 24 * 60 * 60 * 1000;

/** "just now", "5m ago", "3h ago", "4d ago", then the date. */
function timeAgo(iso: string | null) {
  if (!iso) return "Never";
  const elapsed = Date.now() - new Date(iso).getTime();
  if (elapsed < 60_000) return "Just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  if (elapsed < 30 * DAY_MS) return `${Math.floor(elapsed / DAY_MS)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
}

function withinDays(iso: string | null, days: number) {
  return Boolean(iso) && Date.now() - new Date(iso!).getTime() < days * DAY_MS;
}

/** One letter for the avatar: the email's first letter or digit. */
function initial(email: string | null) {
  return (email ?? "?").match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase() ?? "?";
}

/** Five stars, the first `value` (rounded to the nearest half) lit. */
function Stars({ value, label }: { value: number; label?: string }) {
  const rounded = Math.round(value * 2) / 2;
  return (
    <span className="admin-stars" role="img" aria-label={label ?? `${value.toFixed(1)} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((star) => (
        <span
          key={star}
          className={
            rounded >= star ? "is-on" : rounded >= star - 0.5 ? "is-half" : undefined
          }
          aria-hidden="true"
        >
          ★
        </span>
      ))}
    </span>
  );
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
  // Bumped by Refresh to fetch again; the time the data last arrived.
  const [reloadKey, setReloadKey] = useState(0);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let active = true;
    setRefreshing(true);
    apiFetch("/api/admin")
      .then(async (res) => {
        await throwIfError(res, "Could not load admin data");
        return (await res.json()) as Overview;
      })
      .then((data) => {
        if (!active) return;
        setOverview(data);
        setError(null);
        setLoadedAt(Date.now());
      })
      .catch((err: Error) => {
        if (active) setError(err.message);
      })
      .finally(() => {
        if (active) setRefreshing(false);
      });
    return () => {
      active = false;
    };
  }, [reloadKey]);

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

  const stats = useMemo(() => {
    const allUsers = overview?.users ?? [];
    const allFeedback = overview?.feedback ?? [];
    const distribution = [5, 4, 3, 2, 1].map((stars) => ({
      stars,
      count: allFeedback.filter((row) => row.rating === stars).length,
    }));
    return {
      users: allUsers.length,
      newThisWeek: allUsers.filter((user) => withinDays(user.created_at, 7)).length,
      activeThisWeek: allUsers.filter((user) => withinDays(user.last_sign_in_at, 7)).length,
      onboarded: allUsers.filter((user) => user.email_confirmed_at && user.nda_accepted_at).length,
      feedback: allFeedback.length,
      feedbackThisWeek: allFeedback.filter((row) => withinDays(row.submitted_at, 7)).length,
      reviewers: new Set(allFeedback.map((row) => row.user_id)).size,
      average: averageRating(allFeedback),
      distribution,
      maxCount: Math.max(1, ...distribution.map((row) => row.count)),
      latestComments: allFeedback.filter((row) => row.comment?.trim()).slice(0, 3),
    };
  }, [overview]);

  const onboardedShare = stats.users ? stats.onboarded / stats.users : 0;

  return (
    <main className="account-page admin-page">
      <Seo title="Admin" description="Users and audition feedback." path="/admin" noindex />
      <SiteNav />

      <section className="account-main admin-main">
        <header className="admin-header">
          <div>
            <p className="admin-eyebrow">Admin</p>
            <h1>Users &amp; feedback</h1>
            <p className="admin-subtitle">
              {loadedAt
                ? `Everyone in the beta and what they're telling us · updated ${timeAgo(new Date(loadedAt).toISOString()).toLowerCase()}`
                : "Everyone in the beta and what they're telling us"}
            </p>
          </div>
          <button
            type="button"
            className="btn-secondary admin-refresh"
            onClick={() => setReloadKey((key) => key + 1)}
            disabled={refreshing}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={refreshing ? "is-spinning" : undefined}>
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 4v5h-5" />
            </svg>
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </header>

        {error && (
          <div className="admin-error" role="alert">
            <p>{error}</p>
            <button type="button" className="btn-secondary" onClick={() => setReloadKey((key) => key + 1)}>
              Try again
            </button>
          </div>
        )}

        {!overview && !error && <AdminSkeleton />}

        {overview && (
          <>
            <dl className="admin-kpis">
              <div className="admin-kpi">
                <dt>Users</dt>
                <dd>{stats.users}</dd>
                <p>
                  {stats.newThisWeek > 0 ? <strong>+{stats.newThisWeek}</strong> : "No new signups"}
                  {stats.newThisWeek > 0 && " this week"} · {stats.activeThisWeek} active
                </p>
              </div>
              <div className="admin-kpi">
                <dt>Onboarded</dt>
                <dd>
                  {Math.round(onboardedShare * 100)}
                  <span className="admin-kpi-unit">%</span>
                </dd>
                <div
                  className="admin-meter"
                  role="meter"
                  aria-valuemin={0}
                  aria-valuemax={stats.users}
                  aria-valuenow={stats.onboarded}
                  aria-label="Users who confirmed their email and accepted the NDA"
                >
                  <i style={{ width: `${onboardedShare * 100}%` }} />
                </div>
                <p>
                  {stats.onboarded} of {stats.users} confirmed email &amp; NDA
                </p>
              </div>
              <div className="admin-kpi">
                <dt>Feedback</dt>
                <dd>{stats.feedback}</dd>
                <p>
                  {stats.feedbackThisWeek > 0 ? <strong>+{stats.feedbackThisWeek}</strong> : "None"}
                  {" this week"} · from {stats.reviewers} {stats.reviewers === 1 ? "actor" : "actors"}
                </p>
              </div>
              <div className="admin-kpi">
                <dt>Average rating</dt>
                <dd>
                  {stats.average === null ? "—" : stats.average.toFixed(1)}
                  {stats.average !== null && <span className="admin-kpi-unit">/ 5</span>}
                </dd>
                {stats.average !== null ? (
                  <Stars value={stats.average} />
                ) : (
                  <p>No ratings yet</p>
                )}
              </div>
            </dl>

            <div className="admin-insights">
              <section className="admin-panel" aria-labelledby="admin-ratings-title">
                <h2 id="admin-ratings-title">Ratings</h2>
                <p className="admin-panel-sub">
                  {stats.feedback} {stats.feedback === 1 ? "take" : "takes"} rated
                </p>
                <ol className="admin-distribution">
                  {stats.distribution.map((row) => {
                    const share = stats.feedback ? row.count / stats.feedback : 0;
                    const tip = `${row.count} ${row.count === 1 ? "take" : "takes"} rated ${row.stars}★ · ${Math.round(share * 100)}%`;
                    return (
                      <li key={row.stars} tabIndex={0} aria-label={tip} data-tip={tip}>
                        <span className="admin-distribution-label" aria-hidden="true">
                          {row.stars}★
                        </span>
                        <span className="admin-distribution-track" aria-hidden="true">
                          <i style={{ width: `${(row.count / stats.maxCount) * 100}%` }} />
                        </span>
                        <span className="admin-distribution-count" aria-hidden="true">
                          {row.count}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              </section>

              <section className="admin-panel" aria-labelledby="admin-latest-title">
                <h2 id="admin-latest-title">Latest comments</h2>
                {stats.latestComments.length === 0 ? (
                  <p className="admin-empty">No comments yet.</p>
                ) : (
                  <ul className="admin-latest">
                    {stats.latestComments.map((row) => (
                      <li key={row.id}>
                        <blockquote>{row.comment}</blockquote>
                        <p>
                          <Stars value={row.rating} label={`${row.rating} out of 5 stars`} />
                          <span>{emailById.get(row.user_id) ?? "Unknown user"}</span>
                          <span title={formatDate(row.submitted_at)}>{timeAgo(row.submitted_at)}</span>
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>

            <div className="admin-toolbar">
              <div className="admin-tabs" role="tablist" aria-label="Admin views">
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "users"}
                  className={`admin-tab ${tab === "users" ? "is-active" : ""}`}
                  onClick={() => setTab("users")}
                >
                  Users <span className="admin-tab-count">{users.length}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "feedback"}
                  className={`admin-tab ${tab === "feedback" ? "is-active" : ""}`}
                  onClick={() => setTab("feedback")}
                >
                  All feedback <span className="admin-tab-count">{feedback.length}</span>
                </button>
              </div>
              <label className="admin-search">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" />
                  <path d="m20 20-3.5-3.5" />
                </svg>
                <input
                  type="search"
                  placeholder={tab === "users" ? "Search by email" : "Search email or comment"}
                  aria-label="Search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
            </div>

            {tab === "users" ? (
              <div className="admin-table">
                <div className="admin-table-head" aria-hidden="true">
                  <span>User</span>
                  <span>Joined</span>
                  <span>Last active</span>
                  <span>Feedback</span>
                  <span />
                </div>
                {users.length === 0 && <p className="admin-empty admin-table-empty">No matching users.</p>}
                {users.map((user) => {
                  const rows = feedbackByUser.get(user.id) ?? [];
                  const average = averageRating(rows);
                  const expanded = expandedUserId === user.id;
                  return (
                    <div key={user.id} className={`admin-user ${expanded ? "is-expanded" : ""}`}>
                      <button
                        type="button"
                        className="admin-user-summary"
                        aria-expanded={expanded}
                        onClick={() => setExpandedUserId(expanded ? null : user.id)}
                      >
                        <span className="admin-user-cell">
                          <span className="admin-avatar" aria-hidden="true">{initial(user.email)}</span>
                          <span className="admin-user-identity">
                            <span className="admin-user-email">{user.email ?? user.id}</span>
                            <span className="admin-badges">
                              {user.is_admin && <span className="admin-badge">Admin</span>}
                              {!user.email_confirmed_at && (
                                <span className="admin-badge admin-badge--muted">Unconfirmed</span>
                              )}
                              {!user.nda_accepted_at && (
                                <span className="admin-badge admin-badge--muted">No NDA</span>
                              )}
                              {user.subscription_status && user.subscription_status !== "free" && (
                                <span className="admin-badge admin-badge--muted">{user.subscription_status}</span>
                              )}
                            </span>
                          </span>
                        </span>
                        <span className="admin-cell" title={formatDate(user.created_at)}>
                          <span className="admin-cell-label">Joined </span>
                          {timeAgo(user.created_at)}
                        </span>
                        <span className="admin-cell" title={formatDate(user.last_sign_in_at)}>
                          <span className="admin-cell-label">Last active </span>
                          {timeAgo(user.last_sign_in_at)}
                        </span>
                        <span className="admin-cell admin-cell-feedback">
                          <span className="admin-cell-label">Feedback </span>
                          {rows.length === 0 ? (
                            <span className="admin-muted">None</span>
                          ) : (
                            <>
                              <strong>{rows.length}</strong>
                              {average !== null && <Stars value={average} />}
                            </>
                          )}
                        </span>
                        <span className="admin-chevron" aria-hidden="true">
                          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="m6 9 6 6 6-6" />
                          </svg>
                        </span>
                      </button>
                      {expanded && (
                        <div className="admin-user-feedback">
                          <p className="admin-user-facts">
                            Joined {formatDate(user.created_at)} · Last sign-in {formatDate(user.last_sign_in_at)}
                            {user.free_sessions_used !== null && ` · ${user.free_sessions_used} sessions used`}
                          </p>
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
                    </div>
                  );
                })}
              </div>
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

/** Placeholder tiles and rows while the overview loads. */
function AdminSkeleton() {
  return (
    <div className="admin-skeleton" aria-busy="true" aria-label="Loading admin data">
      <div className="admin-kpis">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="admin-kpi admin-skeleton-block" />
        ))}
      </div>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="admin-skeleton-row admin-skeleton-block" />
      ))}
    </div>
  );
}

function FeedbackItem({ feedback, email }: { feedback: Feedback; email?: string | null }) {
  const chips = [
    feedback.device_class && { label: "Device", value: feedback.device_class },
    feedback.reader_latency_ms_p50 != null && {
      label: "Reader latency",
      value: `${feedback.reader_latency_ms_p50}ms p50 · ${feedback.reader_latency_ms_max ?? "—"}ms max`,
    },
    feedback.lines_auto_detected != null && { label: "Auto-advanced", value: feedback.lines_auto_detected },
    feedback.lines_manual_next != null && { label: "Manual next", value: feedback.lines_manual_next },
    feedback.lines_semantic_advanced != null && { label: "Semantic", value: feedback.lines_semantic_advanced },
    feedback.lines_silence_advanced != null && { label: "Silence", value: feedback.lines_silence_advanced },
    feedback.lines_backtracked_after_auto != null && {
      label: "Backtracked",
      value: feedback.lines_backtracked_after_auto,
    },
    feedback.video_width != null &&
      feedback.video_height != null && {
        label: "Video",
        value: `${feedback.video_width}×${feedback.video_height}`,
      },
  ].filter(Boolean) as { label: string; value: string | number }[];

  return (
    <li className="admin-feedback">
      <div className="admin-feedback-head">
        <Stars value={feedback.rating} label={`${feedback.rating} out of 5 stars`} />
        {email && (
          <span className="admin-feedback-author">
            <span className="admin-avatar admin-avatar--small" aria-hidden="true">{initial(email)}</span>
            {email}
          </span>
        )}
        <span className="admin-feedback-time" title={formatDate(feedback.submitted_at)}>
          {timeAgo(feedback.submitted_at)}
        </span>
      </div>
      {feedback.comment ? (
        <blockquote className="admin-feedback-comment">{feedback.comment}</blockquote>
      ) : (
        <p className="admin-feedback-comment admin-feedback-comment--empty">No comment</p>
      )}
      {chips.length > 0 && (
        <ul className="admin-chips" aria-label="Take metrics">
          {chips.map((chip) => (
            <li key={chip.label}>
              <span>{chip.label}</span>
              {chip.value}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
