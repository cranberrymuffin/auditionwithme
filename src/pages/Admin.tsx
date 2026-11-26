import { Fragment, useEffect, useMemo, useState } from "react";
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
  terms_accepted_at: string | null;
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

type Overview = {
  users: AdminUser[];
  /** The newest rows, a page at a time (api/admin.ts ?feedbackOffset). */
  feedback: Feedback[];
  /** Every feedback row there is, loaded or not. */
  feedbackTotal?: number;
};

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
  const [loadingMore, setLoadingMore] = useState(false);

  /** The next page of older feedback, added under what's loaded. */
  const loadMoreFeedback = async () => {
    if (!overview || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await apiFetch(`/api/admin?feedbackOffset=${overview.feedback.length}`);
      await throwIfError(res, "Could not load more feedback");
      const page = (await res.json()) as Overview;
      setOverview((current) => {
        if (!current) return current;
        // Rows submitted since the first load shift the pages: skip repeats.
        const seen = new Set(current.feedback.map((row) => row.id));
        return {
          ...current,
          feedback: [...current.feedback, ...page.feedback.filter((row) => !seen.has(row.id))],
          feedbackTotal: page.feedbackTotal ?? current.feedbackTotal,
        };
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load more feedback");
    } finally {
      setLoadingMore(false);
    }
  };

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
      onboarded: allUsers.filter((user) => user.email_confirmed_at && (user.nda_accepted_at || user.terms_accepted_at)).length,
      feedback: allFeedback.length,
      // The true count; everything else about feedback here is worked out
      // from the rows loaded so far.
      feedbackTotal: Math.max(overview?.feedbackTotal ?? 0, allFeedback.length),
      feedbackThisWeek: allFeedback.filter((row) => withinDays(row.submitted_at, 7)).length,
      reviewers: new Set(allFeedback.map((row) => row.user_id)).size,
      average: averageRating(allFeedback),
      distribution,
      maxCount: Math.max(1, ...distribution.map((row) => row.count)),
      latestComments: allFeedback.filter((row) => row.comment?.trim()).slice(0, 3),
    };
  }, [overview]);

  const onboardedShare = stats.users ? stats.onboarded / stats.users : 0;
  const feedbackPartial = stats.feedback < stats.feedbackTotal;
  // Said beside each figure that only covers the loaded rows.
  const latestNote = feedbackPartial ? `latest ${stats.feedback}` : null;

  return (
    <main className="page account-page admin-page">
      <Seo title="Admin" description="Users and audition feedback." path="/admin" noindex />
      <SiteNav />

      <section className="wrap admin-main">
        <header className="admin-header">
          <div>
            <p className="slug">Admin</p>
            <h1 className="title">Users &amp; feedback</h1>
            <p className="meta admin-subtitle">
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
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </header>

        {error && (
          <div className="notice notice-danger admin-error" role="alert">
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
                <dd>{stats.feedbackTotal}</dd>
                <p>
                  {stats.feedbackThisWeek > 0 ? <strong>+{stats.feedbackThisWeek}</strong> : "None"}
                  {" this week"} · from {stats.reviewers} {stats.reviewers === 1 ? "actor" : "actors"}
                  {latestNote && ` (${latestNote})`}
                </p>
              </div>
              <div className="admin-kpi">
                <dt>Average rating{latestNote && ` (${latestNote})`}</dt>
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

            <div className="grid admin-insights">
              <section className="span-5" aria-labelledby="admin-ratings-title">
                <h2 id="admin-ratings-title" className="admin-section-title">
                  Ratings
                </h2>
                <p className="meta">
                  {feedbackPartial
                    ? `Latest ${stats.feedback} of ${stats.feedbackTotal} takes rated`
                    : `${stats.feedback} ${stats.feedback === 1 ? "take" : "takes"} rated`}
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

              <section className="span-7" aria-labelledby="admin-latest-title">
                <h2 id="admin-latest-title" className="admin-section-title">
                  Latest comments
                </h2>
                {stats.latestComments.length === 0 ? (
                  <p className="meta admin-empty">No comments yet.</p>
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
              <div className="tabs admin-tabs" role="tablist" aria-label="Admin views">
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
                  All feedback{" "}
                  <span className="admin-tab-count">
                    {needle || !feedbackPartial ? feedback.length : stats.feedbackTotal}
                  </span>
                </button>
              </div>
              <input
                type="search"
                className="input admin-search"
                placeholder={tab === "users" ? "Search by email" : "Search email or comment"}
                aria-label="Search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>

            {tab === "users" ? (
              // Focusable so the keyboard can scroll it where it's narrower
              // than its table.
              <div className="admin-table-wrap" role="region" aria-label="Users" tabIndex={0}>
                <table className="admin-table admin-users">
                  <thead>
                    <tr>
                      <th scope="col">User</th>
                      <th scope="col">Joined</th>
                      <th scope="col">Last active</th>
                      <th scope="col" className="is-num">Sessions</th>
                      <th scope="col" className="is-num">Feedback</th>
                      <th scope="col">Average rating</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.length === 0 && (
                      <tr>
                        <td colSpan={6} className="admin-empty">
                          No matching users.
                        </td>
                      </tr>
                    )}
                    {users.map((user) => {
                      const rows = feedbackByUser.get(user.id) ?? [];
                      const average = averageRating(rows);
                      const expanded = expandedUserId === user.id;
                      return (
                        <Fragment key={user.id}>
                          {/* The button carries the control for keyboards and
                              screen readers; a click anywhere on the row
                              reaches the same handler. */}
                          <tr
                            className={`admin-user ${expanded ? "is-expanded" : ""}`}
                            onClick={() => setExpandedUserId(expanded ? null : user.id)}
                          >
                            <th scope="row">
                              <button type="button" className="admin-user-toggle" aria-expanded={expanded}>
                                <span className="admin-user-email">{user.email ?? user.id}</span>
                              </button>
                              <span className="admin-badges">
                                {user.is_admin && <span className="tag tag-accent">Admin</span>}
                                {!user.email_confirmed_at && <span className="tag">Unconfirmed</span>}
                                {!user.nda_accepted_at && !user.terms_accepted_at && (
                                  <span className="tag">No agreement</span>
                                )}
                                {user.subscription_status && user.subscription_status !== "free" && (
                                  <span className="tag">{user.subscription_status}</span>
                                )}
                              </span>
                            </th>
                            <td title={formatDate(user.created_at)}>{timeAgo(user.created_at)}</td>
                            <td title={formatDate(user.last_sign_in_at)}>{timeAgo(user.last_sign_in_at)}</td>
                            <td className="is-num">{user.free_sessions_used ?? "—"}</td>
                            <td className="is-num">{rows.length}</td>
                            <td>
                              {average === null ? (
                                <span className="admin-muted">—</span>
                              ) : (
                                <span className="admin-rating">
                                  <span className="admin-rating-value">{average.toFixed(1)}</span>
                                  <Stars value={average} />
                                </span>
                              )}
                            </td>
                          </tr>
                          {expanded && (
                            <tr className="admin-user-detail">
                              <td colSpan={6}>
                                <div className="admin-user-detail-body">
                                <p className="admin-user-facts">
                                  Joined {formatDate(user.created_at)} · Last sign-in {formatDate(user.last_sign_in_at)}
                                  {user.free_sessions_used !== null && ` · ${user.free_sessions_used} sessions used`}
                                </p>
                                {rows.length === 0 ? (
                                  <p className="meta admin-empty">No feedback yet.</p>
                                ) : (
                                  <ul className="admin-list">
                                    {rows.map((row) => (
                                      <FeedbackItem key={row.id} feedback={row} />
                                    ))}
                                  </ul>
                                )}
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="admin-table-wrap" role="region" aria-label="All feedback" tabIndex={0}>
                <table className="admin-table admin-feedback-table">
                  <thead>
                    <tr>
                      <th scope="col">Sent</th>
                      <th scope="col">Rating</th>
                      <th scope="col">User</th>
                      <th scope="col">Comment</th>
                      <th scope="col">Device</th>
                      <th scope="col" className="is-num">
                        <abbr title="Reader latency in milliseconds: median / slowest">Latency ms</abbr>
                      </th>
                      <th scope="col" className="is-num">
                        <abbr title="Lines the app advanced on hearing them finished">Auto</abbr>
                      </th>
                      <th scope="col" className="is-num">
                        <abbr title="Lines advanced with the Next button">Manual</abbr>
                      </th>
                      <th scope="col" className="is-num">
                        <abbr title="Lines advanced on a semantic match">Sem.</abbr>
                      </th>
                      <th scope="col" className="is-num">
                        <abbr title="Lines advanced after silence">Sil.</abbr>
                      </th>
                      <th scope="col" className="is-num">
                        <abbr title="Lines the actor went back to after an automatic advance">Back</abbr>
                      </th>
                      <th scope="col" className="is-num">Video</th>
                    </tr>
                  </thead>
                  <tbody>
                    {feedback.length === 0 && (
                      <tr>
                        <td colSpan={12} className="admin-empty">
                          No matching feedback.
                        </td>
                      </tr>
                    )}
                    {feedback.map((row) => (
                      <tr key={row.id}>
                        <td title={formatDate(row.submitted_at)}>{timeAgo(row.submitted_at)}</td>
                        <td>
                          <Stars value={row.rating} label={`${row.rating} out of 5 stars`} />
                        </td>
                        <td className="admin-cell-email">{emailById.get(row.user_id) ?? row.user_id}</td>
                        <td className="admin-cell-comment">
                          {row.comment ? row.comment : <span className="admin-muted">No comment</span>}
                        </td>
                        <td>{row.device_class ?? <span className="admin-muted">—</span>}</td>
                        <td className="is-num">
                          {row.reader_latency_ms_p50 != null
                            ? `${row.reader_latency_ms_p50} / ${row.reader_latency_ms_max ?? "—"}`
                            : "—"}
                        </td>
                        <td className="is-num">{row.lines_auto_detected ?? "—"}</td>
                        <td className="is-num">{row.lines_manual_next ?? "—"}</td>
                        <td className="is-num">{row.lines_semantic_advanced ?? "—"}</td>
                        <td className="is-num">{row.lines_silence_advanced ?? "—"}</td>
                        <td className="is-num">{row.lines_backtracked_after_auto ?? "—"}</td>
                        <td className="is-num">
                          {row.video_width != null && row.video_height != null
                            ? `${row.video_width}×${row.video_height}`
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {feedbackPartial && (
              <div className="admin-load-more">
                <p className="meta">
                  Showing the latest {stats.feedback} of {stats.feedbackTotal} feedback
                  rows. Search and each user’s feedback cover only what’s loaded.
                </p>
                <button type="button" className="btn-secondary" disabled={loadingMore} onClick={() => void loadMoreFeedback()}>
                  {loadingMore ? "Loading…" : "Load more"}
                </button>
              </div>
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

/** One piece of feedback under its author's row: rating, comment, and the
 * take's metrics as a line of short fields. */
function FeedbackItem({ feedback }: { feedback: Feedback }) {
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
