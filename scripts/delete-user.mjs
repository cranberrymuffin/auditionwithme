#!/usr/bin/env node
// Deletes a Supabase Auth user and everything that belongs to them:
// entitlements + self_tape_feedback rows (cascade via FK) and, with
// --stripe, their Stripe customer. Scripts and self-tapes themselves live in
// IndexedDB now, not Supabase, so there's nothing server-side to clean up
// for those.
//
// Usage:
//   node scripts/delete-user.mjs <email>              dry run, prints what would be deleted
//   node scripts/delete-user.mjs <email> --confirm     actually deletes
//   node scripts/delete-user.mjs <email> --confirm --stripe   also deletes the Stripe customer
//
// Requires SUPABASE_SERVICE_ROLE_KEY, VITE_SUPABASE_URL (and STRIPE_SECRET_KEY for --stripe)
// in the environment or .env.local.

import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";

async function loadEnvLocal() {
  try {
    const text = await readFile(new URL("../.env.local", import.meta.url), "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // no .env.local, fall back to whatever is already in process.env
  }
}

async function findUserByEmail(supabase, email) {
  const target = email.toLowerCase();
  let page = 1;
  const perPage = 1000;
  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    const match = data.users.find((u) => u.email?.toLowerCase() === target);
    if (match) return match;
    if (data.users.length < perPage) return null;
    page += 1;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const email = args.find((a) => !a.startsWith("--"));
  const confirm = args.includes("--confirm");
  const includeStripe = args.includes("--stripe");

  if (!email) {
    console.error("Usage: node scripts/delete-user.mjs <email> [--confirm] [--stripe]");
    process.exit(1);
  }

  await loadEnvLocal();

  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const user = await findUserByEmail(supabase, email);
  if (!user) {
    console.log(`No user found for ${email}. Nothing to do.`);
    return;
  }

  console.log(`Found user ${user.id} (${user.email}), created ${user.created_at}`);

  const { data: entitlement } = await supabase
    .from("entitlements")
    .select("stripe_customer_id, stripe_subscription_id, subscription_status")
    .eq("user_id", user.id)
    .maybeSingle();

  const { count: feedbackCount, error: feedbackError } = await supabase
    .from("self_tape_feedback")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id);
  if (feedbackError) throw new Error(`fetching self_tape_feedback failed: ${feedbackError.message}`);

  console.log(`  entitlements: ${entitlement ? "1 row" : "none"}${
    entitlement?.stripe_customer_id ? ` (stripe customer ${entitlement.stripe_customer_id})` : ""
  }`);
  console.log(`  self_tape_feedback rows: ${feedbackCount ?? 0}`);

  if (includeStripe && !entitlement?.stripe_customer_id) {
    console.log("  --stripe passed but no stripe_customer_id on file; nothing to do there.");
  }

  if (!confirm) {
    console.log("\nDry run only — no data was deleted. Re-run with --confirm to actually delete.");
    return;
  }

  if (includeStripe && entitlement?.stripe_customer_id) {
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeSecretKey) {
      console.error("STRIPE_SECRET_KEY must be set to use --stripe");
      process.exit(1);
    }
    const { default: Stripe } = await import("stripe");
    const stripe = new Stripe(stripeSecretKey);
    await stripe.customers.del(entitlement.stripe_customer_id);
    console.log(`Deleted Stripe customer ${entitlement.stripe_customer_id}.`);
  }

  // Deleting the auth user cascades entitlements + self_tape_feedback rows
  // via FK (on delete cascade — see supabase/migrations/*_init_entitlements.sql
  // and *_self_tape_feedback_standalone.sql).
  const { error: deleteError } = await supabase.auth.admin.deleteUser(user.id);
  if (deleteError) throw new Error(`deleting auth user failed: ${deleteError.message}`);

  console.log(`Deleted auth user ${user.id} (${email}) and all cascaded data.`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
