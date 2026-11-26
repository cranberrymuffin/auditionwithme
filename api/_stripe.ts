import Stripe from "stripe";

// Keep in sync with scripts/stripe-setup.mjs.
const STRIPE_API_VERSION = "2026-07-29.dahlia";

let client: Stripe | null = null;

/** The Stripe client, built on first use: the constructor throws without a
 * key, and a route should get to answer "Billing is not configured" (and
 * routes that only sometimes need Stripe should load at all) before that. */
export function stripeClient(): Stripe {
  if (client) return client;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY must be set");
  client = new Stripe(key, { apiVersion: STRIPE_API_VERSION });
  return client;
}
