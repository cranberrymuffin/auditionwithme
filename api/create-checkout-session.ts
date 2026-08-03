import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import { requireAuth } from "./_entitlement.js";

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Same service-role client pattern as api/_entitlement.ts — bypasses RLS so we
// can read/write the caller's entitlements row server-side.
function serviceClient() {
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "", {
  apiVersion: "2025-03-31.basil",
});

// Starts a Stripe Checkout session for the single $7/month plan. Never writes
// subscription_status — only the webhook does that (plan Principle 3).
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;

  const priceId = process.env.STRIPE_PRICE_ID;
  if (!priceId || !process.env.STRIPE_SECRET_KEY) {
    console.error("STRIPE_SECRET_KEY and STRIPE_PRICE_ID must be set");
    return res.status(500).json({ error: "Billing is not configured" });
  }
  if (!priceId.startsWith("price_")) {
    console.error("Invalid STRIPE_PRICE_ID:", priceId);
    return res.status(500).json({ error: "Billing price ID is invalid. Use a Stripe price ID starting with price_." });
  }

  const origin = process.env.SITE_URL ?? req.headers.origin;
  if (!origin) {
    return res.status(400).json({ error: "Missing origin" });
  }

  try {
    const db = serviceClient();
    const { data: row, error } = await db
      .from("entitlements")
      .select("stripe_customer_id")
      .eq("user_id", auth.userId)
      .maybeSingle();
    if (error) {
      console.error("entitlements read failed:", error.message);
      return res.status(500).json({ error: "Could not load billing account" });
    }

    let customerId: string | null = row?.stripe_customer_id ?? null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        metadata: { supabase_user_id: auth.userId },
      });
      customerId = customer.id;
      const { error: writeError } = await db
        .from("entitlements")
        .update({ stripe_customer_id: customerId })
        .eq("user_id", auth.userId);
      if (writeError) {
        // The customer exists in Stripe but we couldn't remember it. Fail here
        // rather than proceeding — the webhook matches on stripe_customer_id.
        console.error("entitlements stripe_customer_id write failed:", writeError.message);
        return res.status(500).json({ error: "Could not save billing account" });
      }
      console.log(`stripe customer created ${customerId} for user ${auth.userId}`);
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      customer: customerId,
      client_reference_id: auth.userId,
      success_url: `${origin}/pricing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/pricing?checkout=cancelled`,
    });

    return res.status(200).json({ url: session.url });
  } catch (error) {
    console.error("create-checkout-session failed:", error);
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: `Could not start checkout: ${message}` });
  }
}
