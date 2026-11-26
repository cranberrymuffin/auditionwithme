import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAuth } from "./_entitlement.js";
import { handleCors } from "./_cors.js";
import { serviceClient } from "./_supabase.js";

// PostgREST caps a single select at 1000 rows, so page through with range(),
// ordered by a unique column so no row lands on two pages or on none.
const PAGE_SIZE = 1000;

async function selectAll<T>(
  db: SupabaseClient,
  table: string,
  columns: string,
  uniqueKey: string,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await db
      .from(table)
      .select(columns)
      .order(uniqueKey)
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    rows.push(...(data as T[]));
    if (data.length < PAGE_SIZE) return rows;
  }
}

async function listAllUsers(db: SupabaseClient) {
  const users = [];
  for (let page = 1; ; page += 1) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: PAGE_SIZE });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    users.push(...data.users);
    if (data.users.length < PAGE_SIZE) return users;
  }
}

// Feedback rows carry the comment and a metrics blob each, so unlike the
// narrow user tables they are not all loaded: the newest FEEDBACK_DEFAULT_LIMIT
// by default, and a caller can page further back.
const FEEDBACK_DEFAULT_LIMIT = 500;
const FEEDBACK_MAX_LIMIT = 1000;

function intParam(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(Array.isArray(value) ? value[0] : value);
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}

type FeedbackRow = { id: string; submitted_at: string };

/** One page of feedback, newest first, and how many rows there are in all. */
async function selectFeedback(
  db: SupabaseClient,
  limit: number,
  offset: number,
): Promise<{ rows: FeedbackRow[]; total: number }> {
  const { data, error, count } = await db
    .from("self_tape_feedback")
    .select("*", { count: "exact" })
    .order("submitted_at", { ascending: false })
    // Ties on the timestamp still need one fixed order to page through.
    .order("id")
    .range(offset, offset + limit - 1);
  if (error) throw new Error(`self_tape_feedback read failed: ${error.message}`);
  return { rows: data as FeedbackRow[], total: count ?? data.length };
}

type EntitlementRow = {
  user_id: string;
  subscription_status: string;
  free_sessions_used: number;
  nda_accepted_at: string | null;
  terms_accepted_at: string | null;
};

// Everything the admin portal (src/pages/Admin.tsx) shows, in one response:
// every account plus the most recent audition feedback. ?feedbackLimit and
// ?feedbackOffset page through older feedback; feedbackTotal says how much
// there is.
async function adminOverview(req: VercelRequest, res: VercelResponse) {
  const feedbackLimit = intParam(
    req.query.feedbackLimit,
    FEEDBACK_DEFAULT_LIMIT,
    1,
    FEEDBACK_MAX_LIMIT,
  );
  const feedbackOffset = intParam(req.query.feedbackOffset, 0, 0, Number.MAX_SAFE_INTEGER);
  const db = serviceClient();
  const [users, entitlements, admins, feedback] = await Promise.all([
    listAllUsers(db),
    selectAll<EntitlementRow>(
      db,
      "entitlements",
      "user_id, subscription_status, free_sessions_used, nda_accepted_at, terms_accepted_at",
      "user_id",
    ),
    selectAll<{ user_id: string }>(db, "admins", "user_id", "user_id"),
    selectFeedback(db, feedbackLimit, feedbackOffset),
  ]);

  const entitlementByUser = new Map(entitlements.map((row) => [row.user_id, row]));
  const adminIds = new Set(admins.map((row) => row.user_id));

  return res.status(200).json({
    users: users.map((user) => {
      const entitlement = entitlementByUser.get(user.id);
      return {
        id: user.id,
        email: user.email ?? null,
        created_at: user.created_at,
        last_sign_in_at: user.last_sign_in_at ?? null,
        email_confirmed_at: user.email_confirmed_at ?? null,
        is_admin: adminIds.has(user.id),
        subscription_status: entitlement?.subscription_status ?? null,
        free_sessions_used: entitlement?.free_sessions_used ?? null,
        nda_accepted_at: entitlement?.nda_accepted_at ?? null,
        terms_accepted_at: entitlement?.terms_accepted_at ?? null,
      };
    }),
    feedback: feedback.rows,
    feedbackTotal: feedback.total,
    feedbackLimit,
    feedbackOffset,
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleCors(req, res)) return;
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;

  try {
    // The real gate for the admin portal: RequireAdmin and the nav link are
    // only UX. 404 rather than 403 so the route doesn't advertise itself.
    const { data: adminRow, error } = await serviceClient()
      .from("admins")
      .select("user_id")
      .eq("user_id", auth.userId)
      .maybeSingle();
    if (error) {
      console.error("admins read failed:", error.message);
      return res.status(500).json({ error: "Could not verify admin access" });
    }
    if (!adminRow) {
      return res.status(404).json({ error: "Not found" });
    }

    return await adminOverview(req, res);
  } catch (err) {
    console.error("admin overview failed:", err);
    return res.status(500).json({ error: "Could not load admin data" });
  }
}
