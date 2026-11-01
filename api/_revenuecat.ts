import { createClient } from "@supabase/supabase-js";

// Subscriptions bought in the iOS app are Apple In-App Purchases, managed by
// RevenueCat. The RevenueCat app user ID is the Supabase user ID
// (src/lib/appStore.ts logs in with it), so one lookup maps a purchase to
// its entitlements row.

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

/** The RevenueCat entitlement the $9.99/month App Store product unlocks. */
const ENTITLEMENT_ID = "pro";

function serviceClient() {
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

type RevenueCatEntitlement = { expires_date: string | null };

async function fetchEntitlement(userId: string): Promise<RevenueCatEntitlement | null> {
  const apiKey = process.env.REVENUECAT_SECRET_API_KEY;
  if (!apiKey) throw new Error("REVENUECAT_SECRET_API_KEY must be set");
  const response = await fetch(
    `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(userId)}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  if (!response.ok) {
    throw new Error(`RevenueCat subscriber lookup failed (${response.status})`);
  }
  const body = (await response.json()) as {
    subscriber?: { entitlements?: Record<string, RevenueCatEntitlement> };
  };
  return body.subscriber?.entitlements?.[ENTITLEMENT_ID] ?? null;
}

/**
 * Re-derives a user's Apple subscription from RevenueCat and writes it to
 * their entitlements row. Like api/stripe-webhook.ts, state is read fresh
 * rather than patched from the event, so replays and out-of-order webhooks
 * converge. Returns whether the Apple subscription is active.
 *
 * Never touches a row a live Stripe subscription owns: starting is skipped
 * while Stripe is active, and ending only applies to Apple's own rows.
 */
export async function syncAppleSubscription(userId: string): Promise<boolean> {
  const entitlement = await fetchEntitlement(userId);
  // Never subscribed through Apple: nothing of Apple's to write.
  if (!entitlement) return false;

  // A null expiry is a non-expiring grant (e.g. one given from the
  // RevenueCat dashboard). Expiry already includes any billing grace period.
  const active =
    entitlement.expires_date === null || Date.parse(entitlement.expires_date) > Date.now();

  const update = serviceClient()
    .from("entitlements")
    .update({
      subscription_status: active ? "active" : "canceled",
      subscription_source: "apple",
      current_period_end: entitlement.expires_date,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);
  const { error } = active
    ? await update.or(
        "subscription_source.is.null,subscription_source.eq.apple,subscription_status.neq.active",
      )
    : await update.eq("subscription_source", "apple");
  if (error) throw new Error(`entitlements update failed: ${error.message}`);
  return active;
}
