#!/usr/bin/env node
// Creates (or finds) the Audition Plus product and its monthly price in
// whichever Stripe account STRIPE_SECRET_KEY belongs to, and prints the
// price ID to put in STRIPE_PRICE_ID. Safe to re-run: the price is matched
// by lookup key, so a second run just prints the existing one.
//
// Usage:
//   node --env-file=.env.local scripts/stripe-setup.mjs            # sandbox
//   STRIPE_SECRET_KEY=sk_live_... node scripts/stripe-setup.mjs    # production
//
// Optionally creates the webhook endpoint too (production only — locally,
// `stripe listen` forwards events instead):
//   STRIPE_SECRET_KEY=sk_live_... node scripts/stripe-setup.mjs \
//     --webhook https://auditionwithme.com/api/stripe-webhook

import Stripe from "stripe";

const PRODUCT_NAME = "Audition Plus";
const LOOKUP_KEY = "audition_plus_monthly_999";
const UNIT_AMOUNT = 999; // $9.99
const CURRENCY = "usd";
const API_VERSION = "2026-07-29.dahlia"; // keep in sync with api/billing.ts

// Every event api/stripe-webhook.ts handles.
const WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_succeeded",
  "invoice.payment_failed",
];

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error("STRIPE_SECRET_KEY must be set");
  process.exit(1);
}

const webhookFlag = process.argv.indexOf("--webhook");
const webhookUrl = webhookFlag === -1 ? null : process.argv[webhookFlag + 1];
if (webhookFlag !== -1 && !webhookUrl?.startsWith("https://")) {
  console.error("--webhook needs an https:// URL");
  process.exit(1);
}

const stripe = new Stripe(key, { apiVersion: API_VERSION });
const account = await stripe.accounts.retrieve();
const mode = key.startsWith("sk_live_") ? "LIVE" : "test";
console.log(
  `Stripe account ${account.id} (${account.settings?.dashboard?.display_name ?? "unnamed"}) — ${mode} mode`,
);

const existing = await stripe.prices.list({
  lookup_keys: [LOOKUP_KEY],
  active: true,
  limit: 1,
});
let price = existing.data[0];

if (price) {
  console.log(`Found existing price ${price.id}`);
} else {
  const products = await stripe.products.search({
    query: `name:"${PRODUCT_NAME}" AND active:"true"`,
    limit: 1,
  });
  const product =
    products.data[0] ??
    (await stripe.products.create({
      name: PRODUCT_NAME,
      description: "Unlimited rehearsals with AI scene partners.",
    }));
  price = await stripe.prices.create({
    product: product.id,
    unit_amount: UNIT_AMOUNT,
    currency: CURRENCY,
    recurring: { interval: "month" },
    lookup_key: LOOKUP_KEY,
    nickname: "Audition Plus monthly",
  });
  console.log(`Created price ${price.id} on product ${product.id}`);
}

if (webhookUrl) {
  const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
  const match = endpoints.data.find((endpoint) => endpoint.url === webhookUrl);
  if (match) {
    console.log(
      `Webhook endpoint ${match.id} already exists for ${webhookUrl}. Its signing secret is in the Stripe dashboard (it is only returned at creation).`,
    );
  } else {
    const endpoint = await stripe.webhookEndpoints.create({
      url: webhookUrl,
      enabled_events: WEBHOOK_EVENTS,
      api_version: API_VERSION,
    });
    console.log(`Created webhook endpoint ${endpoint.id}`);
    console.log(`\nSTRIPE_WEBHOOK_SECRET=${endpoint.secret}`);
  }
}

console.log(`\nSTRIPE_PRICE_ID=${price.id}`);
