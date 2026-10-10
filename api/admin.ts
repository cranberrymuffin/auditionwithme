import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireAuth } from "./_entitlement.js";

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Same service-role client pattern as api/_entitlement.ts — needed for
// auth.admin.listUsers and to read every user's feedback past RLS.
function serviceClient() {
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set",
    );
  }
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

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

type EntitlementRow = {
  user_id: string;
  subscription_status: string;
  free_sessions_used: number;
  nda_accepted_at: string | null;
};

// Everything the admin portal (src/pages/Admin.tsx) shows, in one response:
// every account plus every audition feedback row. Fine at beta scale; split
// into per-user requests if the feedback table grows large.
async function adminOverview(res: VercelResponse) {
  const db = serviceClient();
  const [users, entitlements, admins, feedback] = await Promise.all([
    listAllUsers(db),
    selectAll<EntitlementRow>(
      db,
      "entitlements",
      "user_id, subscription_status, free_sessions_used, nda_accepted_at",
      "user_id",
    ),
    selectAll<{ user_id: string }>(db, "admins", "user_id", "user_id"),
    selectAll<{ submitted_at: string }>(db, "self_tape_feedback", "*", "id"),
  ]);
  feedback.sort((a, b) => b.submitted_at.localeCompare(a.submitted_at));

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
      };
    }),
    feedback,
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
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

    return await adminOverview(res);
  } catch (err) {
    console.error("admin overview failed:", err);
    return res.status(500).json({ error: "Could not load admin data" });
  }
}
