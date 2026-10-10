import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import { requireAuth } from "./_entitlement.js";

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Same service-role client pattern as api/_entitlement.ts — needed for
// auth.admin.deleteUser and to read the caller's entitlements row.
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

// Checks the password the same way the login form does. A bearer token alone
// isn't enough to delete an account — it may be from a session someone left
// open — so the caller has to prove they know the password right now.
async function passwordMatches(email: string, password: string): Promise<boolean> {
  if (!supabaseUrl || !anonKey) {
    throw new Error("VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set");
  }
  const client = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  return !error;
}

// Permanently deletes the caller's account — the self-serve version of
// scripts/delete-user.mjs. Deleting the auth user cascades entitlements,
// self_tape_feedback and rate_limit_buckets via FK; scripts and self-tapes
// live in IndexedDB, which the client clears itself after this succeeds.
async function deleteAccount(
  req: VercelRequest,
  res: VercelResponse,
  auth: { userId: string; email: string },
) {
  const password = req.body?.password;
  if (typeof password !== "string" || !password) {
    return res.status(400).json({ error: "Enter your password to delete your account." });
  }

  try {
    if (!(await passwordMatches(auth.email, password))) {
      return res.status(403).json({ error: "That’s not your current password." });
    }

    const db = serviceClient();
    const { data: row, error } = await db
      .from("entitlements")
      .select("stripe_customer_id")
      .eq("user_id", auth.userId)
      .maybeSingle();
    if (error) {
      console.error("entitlements read failed:", error.message);
      return res.status(500).json({ error: "Could not delete your account" });
    }

    // Deleting the Stripe customer cancels any subscription immediately, so
    // nobody keeps getting billed for an account that no longer exists. If
    // that fails, stop before the auth user goes — otherwise the customer is
    // orphaned with nothing left that points back to it.
    const customerId = row?.stripe_customer_id ?? null;
    if (customerId) {
      if (!process.env.STRIPE_SECRET_KEY) {
        console.error("STRIPE_SECRET_KEY must be set");
        return res.status(500).json({ error: "Could not delete your account" });
      }
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
        apiVersion: "2026-07-29.dahlia",
      });
      await stripe.customers.del(customerId);
      console.log(`stripe customer ${customerId} deleted for user ${auth.userId}`);
    }

    const { error: deleteError } = await db.auth.admin.deleteUser(auth.userId);
    if (deleteError) {
      console.error("deleteUser failed:", deleteError.message);
      return res.status(500).json({ error: "Could not delete your account" });
    }

    console.log(`user ${auth.userId} deleted their account`);
    return res.status(200).json({ deleted: true });
  } catch (err) {
    console.error("delete-account failed:", err);
    return res.status(500).json({ error: "Could not delete your account" });
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "DELETE") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;

  return deleteAccount(req, res, auth);
}
