import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import { requireAuth } from "./_entitlement.js";

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Same service-role client pattern as api/_entitlement.ts.
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

// Opens Stripe's hosted Billing Portal so the user can update payment details
// or cancel. Cancellation comes back to us as a webhook, never from the client.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;

  if (!process.env.STRIPE_SECRET_KEY) {
    console.error("STRIPE_SECRET_KEY must be set");
    return res.status(500).json({ error: "Billing is not configured" });
  }

  const origin = process.env.SITE_URL ?? req.headers.origin;
  if (!origin) {
    return res.status(400).json({ error: "Missing origin" });
  }

  try {
    const { data: row, error } = await serviceClient()
      .from("entitlements")
      .select("stripe_customer_id")
      .eq("user_id", auth.userId)
      .maybeSingle();
    if (error) {
      console.error("entitlements read failed:", error.message);
      return res.status(500).json({ error: "Could not load billing account" });
    }

    const customerId: string | null = row?.stripe_customer_id ?? null;
    if (!customerId) {
      return res.status(400).json({ error: "No billing account found" });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${origin}/pricing`,
    });

    return res.status(200).json({ url: session.url });
  } catch (error) {
    console.error("create-portal-session failed:", error);
    return res.status(500).json({ error: "Could not open billing portal" });
  }
}
