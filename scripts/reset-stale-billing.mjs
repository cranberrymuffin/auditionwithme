#!/usr/bin/env node
// Resets entitlements rows whose Stripe customer doesn't exist in the live
// Stripe account -- billing state left over from the sandbox, from before
// production switched to live keys. Those rows show a stale "active" plan
// (which also grants free access) and break the billing page. Each one is
// put back to free with its Stripe IDs cleared, so the user can subscribe
// again for real. api/billing.ts does the same per user on their next
// billing visit; this cleans up everyone at once.
//
// Usage (a read-only restricted key with Customers read is enough):
//   STRIPE_SECRET_KEY=rk_live_... node scripts/reset-stale-billing.mjs            dry run
//   STRIPE_SECRET_KEY=rk_live_... node scripts/reset-stale-billing.mjs --confirm  apply
//
// Requires SUPABASE_SERVICE_ROLE_KEY and VITE_SUPABASE_URL for the production
// project, in the environment or .env.development.local. STRIPE_SECRET_KEY must be a live
// key: checking against the sandbox would reset every real subscriber.

import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

async function loadEnvLocal() {
  try {
    const text = await readFile(new URL("../.env.development.local", import.meta.url), "utf8");
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
    // no .env.development.local, fall back to whatever is already in process.env
  }
}

async function customerExists(stripe, customerId) {
  try {
    const customer = await stripe.customers.retrieve(customerId);
    return !customer.deleted;
  } catch (error) {
    if (error?.code === "resource_missing") return false;
    throw error;
  }
}

async function main() {
  const confirm = process.argv.includes("--confirm");

  // Read before .env.development.local, whose STRIPE_SECRET_KEY is the sandbox one.
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey?.startsWith("sk_live_") && !stripeKey?.startsWith("rk_live_")) {
    console.error(
      "Set STRIPE_SECRET_KEY to a live key (sk_live_ or rk_live_) on the command line.",
    );
    process.exit(1);
  }

  await loadEnvLocal();
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
    process.exit(1);
  }
  console.log(`Supabase project: ${new URL(supabaseUrl).host}`);

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const stripe = new Stripe(stripeKey);

  const { data: rows, error } = await supabase
    .from("entitlements")
    .select("user_id, stripe_customer_id, subscription_status")
    .not("stripe_customer_id", "is", null);
  if (error) throw new Error(`entitlements read failed: ${error.message}`);

  let stale = 0;
  for (const row of rows) {
    if (await customerExists(stripe, row.stripe_customer_id)) continue;
    stale += 1;
    console.log(
      `${confirm ? "resetting" : "would reset"} user ${row.user_id} ` +
        `(customer ${row.stripe_customer_id}, status ${row.subscription_status})`,
    );
    if (!confirm) continue;
    const { error: writeError } = await supabase
      .from("entitlements")
      .update({
        stripe_customer_id: null,
        stripe_subscription_id: null,
        current_period_end: null,
        subscription_status: "free",
      })
      .eq("user_id", row.user_id)
      .eq("stripe_customer_id", row.stripe_customer_id);
    if (writeError) throw new Error(`reset failed for ${row.user_id}: ${writeError.message}`);
  }

  console.log(
    `\n${rows.length} rows with a Stripe customer, ${stale} not in the live account` +
      (confirm || stale === 0 ? "." : ". Re-run with --confirm to reset them."),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
