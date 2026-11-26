import type { VercelRequest, VercelResponse } from "@vercel/node";
import type Stripe from "stripe";
import { requireAuth } from "./_entitlement.js";
import { TRIAL_DAYS, hasPlanAccess, type Plan } from "../src/lib/plan.js";
import { handleCors } from "./_cors.js";
import { TERMS_VERSION } from "../src/lib/termsText.js";
import { serviceClient } from "./_supabase.js";
import { stripeClient } from "./_stripe.js";
import { emailHasUsedTrial, trialEmailHash } from "./_trial.js";

const PRODUCTION_WEB_ORIGIN = "https://www.auditionwithme.com";

// Where Stripe sends the browser back after a confirmation that needed a
// redirect (3-D Secure and the like). In production this is configured
// (APP_WEB_ORIGIN, else the production site), never taken from the request's
// Origin header, which the caller controls. Local dev and preview
// deployments have no fixed address, so only there is the header used.
function webOrigin(req: VercelRequest): string {
  const configured = process.env.APP_WEB_ORIGIN?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  const origin = req.headers.origin;
  if (process.env.VERCEL_ENV !== "production" && origin && /^https?:\/\//.test(origin)) {
    return origin;
  }
  return PRODUCTION_WEB_ORIGIN;
}

// The price is read from Stripe rather than hardcoded so the pricing page
// always shows what checkout will actually charge. Cached per instance —
// it only changes when STRIPE_PRICE_ID does, which means a redeploy.
let cachedPlan: Plan | null = null;

async function loadPlan(): Promise<Plan> {
  if (cachedPlan) return cachedPlan;
  const price = await stripeClient().prices.retrieve(process.env.STRIPE_PRICE_ID ?? "");
  if (price.unit_amount == null || !price.recurring) {
    throw new Error(`price ${price.id} is not a fixed recurring price`);
  }
  const plan: Plan = {
    amount: price.unit_amount,
    currency: price.currency,
    interval: price.recurring.interval,
    trialDays: TRIAL_DAYS,
  };
  cachedPlan = plan;
  return plan;
}

// Public (no auth) — the pricing page shows the price to signed-out visitors.
async function getPlan(res: VercelResponse) {
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PRICE_ID) {
    console.error("STRIPE_SECRET_KEY and STRIPE_PRICE_ID must be set");
    return res.status(500).json({ error: "Billing is not configured" });
  }
  try {
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=3600");
    return res.status(200).json(await loadPlan());
  } catch (error) {
    console.error("plan lookup failed:", error);
    return res.status(500).json({ error: "Could not load pricing" });
  }
}

// Whether this customer has ever had a subscription, in any state. The free
// trial is for a customer's first subscription only — otherwise canceling
// during the trial and resubscribing would restart it indefinitely.
async function hasHadSubscription(customerId: string): Promise<boolean> {
  const previous = await stripeClient().subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 1,
  });
  return previous.data.length > 0;
}

// A trial also counts as used when this email has started one before, on an
// account since deleted (api/_trial.ts).
async function isTrialEligible(customerId: string | null, email: string): Promise<boolean> {
  if (await emailHasUsedTrial(email)) return false;
  return !customerId || !(await hasHadSubscription(customerId));
}

// Subscriptions that are still running or could still start: everything but
// the two ended states. An "incomplete" one counts — its first payment is
// mid-confirmation, and it turns active without another request.
async function hasOpenSubscription(customerId: string): Promise<boolean> {
  const subscriptions = await stripeClient().subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 20,
  });
  return subscriptions.data.some(
    (subscription) =>
      subscription.status !== "canceled" && subscription.status !== "incomplete_expired",
  );
}

// Saved Stripe IDs can belong to a different Stripe account or mode than the
// current key -- e.g. sandbox customers left over after production switched
// to live keys. Stripe answers those lookups with "resource_missing".
//
// Only a live key may treat a missing customer as stale: preview and local
// dev run the sandbox key against the same database, where a real subscriber's
// live customer would look missing and get wiped.
const CAN_RESET_STALE_BILLING =
  process.env.STRIPE_SECRET_KEY?.startsWith("sk_live_") ?? false;

async function customerExists(customerId: string): Promise<boolean> {
  if (!CAN_RESET_STALE_BILLING) return true;
  try {
    const customer = await stripeClient().customers.retrieve(customerId);
    return !("deleted" in customer && customer.deleted);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "resource_missing") return false;
    throw error;
  }
}

// Clears billing state that doesn't exist in this Stripe account, so the user
// starts over as free and checkout creates a fresh customer. Matching on the
// stale customer ID keeps this from clobbering a row the webhook just updated.
async function resetStaleBilling(userId: string, customerId: string) {
  console.warn(
    `stripe customer ${customerId} not found in this account; resetting billing for user ${userId}`,
  );
  const { error } = await serviceClient()
    .from("entitlements")
    .update({
      stripe_customer_id: null,
      stripe_subscription_id: null,
      current_period_end: null,
      subscription_status: "free",
    })
    .eq("user_id", userId)
    .eq("stripe_customer_id", customerId);
  if (error) throw new Error(`stale billing reset failed: ${error.message}`);
}

// Read-only view of the caller's Stripe billing state, fetched live so the
// account/billing page can never drift from what Stripe actually has —
// nothing here is cached in Supabase.
async function getBillingSummary(
  res: VercelResponse,
  auth: { userId: string; email: string },
) {
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error("STRIPE_SECRET_KEY must be set");
    return res.status(500).json({ error: "Billing is not configured" });
  }

  try {
    const { data: row, error } = await serviceClient()
      .from("entitlements")
      .select("stripe_customer_id, stripe_subscription_id")
      .eq("user_id", auth.userId)
      .maybeSingle();
    if (error) {
      console.error("entitlements read failed:", error.message);
      return res.status(500).json({ error: "Could not load billing account" });
    }

    const customerId = row?.stripe_customer_id ?? null;
    if (!customerId) {
      return res.status(200).json({
        subscription: null,
        invoices: [],
        trialEligible: await isTrialEligible(null, auth.email),
      });
    }
    if (!(await customerExists(customerId))) {
      await resetStaleBilling(auth.userId, customerId);
      return res.status(200).json({
        subscription: null,
        invoices: [],
        trialEligible: await isTrialEligible(null, auth.email),
      });
    }

    const subscriptionId = row?.stripe_subscription_id ?? null;
    let subscription: Stripe.Subscription | null = null;
    if (subscriptionId) {
      try {
        subscription = await stripeClient().subscriptions.retrieve(subscriptionId, {
          expand: ["default_payment_method"],
        });
      } catch (err) {
        // Subscription may have been deleted on Stripe's side; treat as none.
        console.error(`subscription ${subscriptionId} retrieve failed:`, err);
      }
    }

    // The customer's default_payment_method is the field the setup-mode
    // webhook handler (stripe-webhook.ts) always updates, so it's the
    // freshest source once a user has ever changed their card. Subscriptions
    // created via a Checkout Session with Managed Payments reject changes to
    // their own default_payment_method entirely, so that field can go stale
    // forever — fall back to it only when the customer has never set one
    // (e.g. a day-one subscriber who hasn't used "update payment method" yet).
    const customer = await stripeClient().customers.retrieve(customerId, {
      expand: ["invoice_settings.default_payment_method"],
    });
    const customerDefault =
      "deleted" in customer
        ? null
        : customer.invoice_settings.default_payment_method &&
            typeof customer.invoice_settings.default_payment_method !== "string"
          ? customer.invoice_settings.default_payment_method
          : null;

    const subscriptionDefault =
      subscription?.default_payment_method &&
      typeof subscription.default_payment_method !== "string"
        ? subscription.default_payment_method
        : null;

    const paymentMethod = customerDefault ?? subscriptionDefault;

    const invoices = await stripeClient().invoices.list({
      customer: customerId,
      limit: 12,
    });

    const price = subscription?.items.data[0]?.price;

    return res.status(200).json({
      // A subscription row exists once checkout completes, so a customer
      // with no row may still have had one (e.g. it was deleted in Stripe).
      trialEligible: !subscription && (await isTrialEligible(customerId, auth.email)),
      subscription: subscription
        ? {
            status: subscription.status,
            cancelAtPeriodEnd: subscription.cancel_at_period_end,
            trialEnd: subscription.trial_end
              ? new Date(subscription.trial_end * 1000).toISOString()
              : null,
            endedAt: subscription.ended_at
              ? new Date(subscription.ended_at * 1000).toISOString()
              : null,
            plan:
              price?.unit_amount != null
                ? {
                    amount: price.unit_amount,
                    currency: price.currency,
                    interval: price.recurring?.interval ?? "month",
                  }
                : null,
            currentPeriodEnd: subscription.items.data[0]?.current_period_end
              ? new Date(subscription.items.data[0].current_period_end * 1000).toISOString()
              : null,
            card: paymentMethod?.card
              ? {
                  brand: paymentMethod.card.brand,
                  last4: paymentMethod.card.last4,
                }
              : null,
          }
        : null,
      invoices: invoices.data.map((invoice) => ({
        id: invoice.id,
        created: new Date(invoice.created * 1000).toISOString(),
        amountPaid: invoice.amount_paid,
        currency: invoice.currency,
        status: invoice.status,
        hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
      })),
    });
  } catch (error) {
    console.error("billing-summary failed:", error);
    return res.status(500).json({ error: "Could not load billing summary" });
  }
}

const idempotencyMinute = () => Math.floor(Date.now() / 60_000);

// Starts a subscription checkout for the single Audition Plus plan — with a
// free trial if this is the customer's first subscription — and returns a
// Checkout Session client secret for the embedded Payment Element to confirm.
// Never writes subscription_status — only the webhook does that (plan
// Principle 3).
async function createSubscription(
  req: VercelRequest,
  res: VercelResponse,
  auth: { userId: string; email: string },
) {
  const priceId = process.env.STRIPE_PRICE_ID;
  if (!priceId || !process.env.STRIPE_SECRET_KEY) {
    console.error("STRIPE_SECRET_KEY and STRIPE_PRICE_ID must be set");
    return res.status(500).json({ error: "Billing is not configured" });
  }
  if (!priceId.startsWith("price_")) {
    console.error("Invalid STRIPE_PRICE_ID:", priceId);
    return res
      .status(500)
      .json({
        error:
          "Billing price ID is invalid. Use a Stripe price ID starting with price_.",
      });
  }

  try {
    const db = serviceClient();
    const { data: row, error } = await db
      .from("entitlements")
      .select("stripe_customer_id, subscription_status, terms_version")
      .eq("user_id", auth.userId)
      .maybeSingle();
    if (error) {
      console.error("entitlements read failed:", error.message);
      return res.status(500).json({ error: "Could not load billing account" });
    }
    // No subscription without the current Terms -- accepted at signup, or in
    // this request (the pricing-page checkbox for accounts that signed up
    // during beta, before the Terms existed).
    const body = (req.body ?? {}) as { termsVersion?: unknown };
    const acceptingTerms = body.termsVersion === TERMS_VERSION;
    if (row?.terms_version !== TERMS_VERSION && !acceptingTerms) {
      return res.status(403).json({
        error: "Please accept the Terms and Conditions to subscribe.",
        reason: "terms_required",
      });
    }
    // A customer saved from another Stripe account (e.g. sandbox) would
    // otherwise block checkout with a stale "active" status.
    let customerId: string | null = row?.stripe_customer_id ?? null;
    let status = row?.subscription_status;
    if (customerId && !(await customerExists(customerId))) {
      await resetStaleBilling(auth.userId, customerId);
      customerId = null;
      status = "free";
    }
    // Stops a double-click, or a second tab, from starting a second
    // subscription for someone who already has one. The cached status only
    // turns "active" once the webhook lands, so Stripe is asked as well: a
    // second checkout confirmed in that gap would otherwise bill twice.
    if (hasPlanAccess(status)) {
      return res
        .status(409)
        .json({ error: "You already have an active subscription." });
    }
    if (customerId && (await hasOpenSubscription(customerId))) {
      return res.status(409).json({
        error: "You already have a subscription. You can manage it from your Billing page.",
      });
    }

    if (!customerId) {
      // Two requests racing here (a double-click) get the same customer back
      // instead of creating one each. The minute in the key keeps it from
      // outliving the race: Stripe remembers a key for a day, and a customer
      // recreated later must not be answered with the old one.
      const customer = await stripeClient().customers.create(
        {
          email: auth.email,
          metadata: { supabase_user_id: auth.userId },
        },
        { idempotencyKey: `customer-${auth.userId}-${idempotencyMinute()}` },
      );
      // Only claims the row while it still has no customer, so a request that
      // lost the race adopts the winner's customer rather than overwriting it.
      const { data: claimed, error: writeError } = await db
        .from("entitlements")
        .update({ stripe_customer_id: customer.id })
        .eq("user_id", auth.userId)
        .is("stripe_customer_id", null)
        .select("stripe_customer_id");
      if (writeError) {
        // The customer exists in Stripe but we couldn't remember it. Fail here
        // rather than proceeding — the webhook matches on stripe_customer_id.
        console.error(
          "entitlements stripe_customer_id write failed:",
          writeError.message,
        );
        return res
          .status(500)
          .json({ error: "Could not save billing account" });
      }
      if (claimed?.length) {
        customerId = customer.id;
        console.log(
          `stripe customer created ${customerId} for user ${auth.userId}`,
        );
      } else {
        const { data: current, error: rereadError } = await db
          .from("entitlements")
          .select("stripe_customer_id")
          .eq("user_id", auth.userId)
          .maybeSingle();
        if (rereadError || !current?.stripe_customer_id) {
          console.error(
            `entitlements row for user ${auth.userId} could not take stripe customer ${customer.id}:`,
            rereadError?.message ?? "no row, or no customer on it",
          );
          return res
            .status(500)
            .json({ error: "Could not save billing account" });
        }
        customerId = current.stripe_customer_id as string;
        if (customerId !== customer.id) {
          // The other request's customer won; don't leave ours orphaned.
          await stripeClient().customers
            .del(customer.id)
            .catch((error) => console.error(`orphan stripe customer ${customer.id} not deleted:`, error));
        }
        if (await hasOpenSubscription(customerId)) {
          return res.status(409).json({
            error: "You already have a subscription. You can manage it from your Billing page.",
          });
        }
      }
    }

    const trialEligible = await isTrialEligible(customerId, auth.email);

    if (acceptingTerms) {
      const now = new Date().toISOString();
      const { error: termsError } = await db
        .from("entitlements")
        .update({ terms_version: TERMS_VERSION, terms_accepted_at: now })
        .eq("user_id", auth.userId);
      if (termsError) {
        console.error("entitlements terms write failed:", termsError.message);
        return res.status(500).json({ error: "Could not save your agreement" });
      }
    }

    // A Checkout Session doesn't create a Subscription until it completes, so
    // an abandoned attempt just expires on its own — no dedup/reuse needed.
    //
    // Managed Payments (enabled by default on this account) only supports
    // mode: "subscription" and mode: "payment" but takes over payment_method_types
    // itself — opt out so the explicit card-only list below is honored and
    // checkout stays embedded in-app (ui_mode: "elements") rather than
    // redirecting to Stripe-hosted Checkout.
    const session = await stripeClient().checkout.sessions.create(
      {
        customer: customerId,
        line_items: [{ price: priceId, quantity: 1 }],
        mode: "subscription",
        // The card is still collected up front (payment_method_collection
        // defaults to "always"), so the subscription bills automatically when
        // the trial ends unless it's canceled first.
        // The email hash rides on the subscription so the webhook can record
        // the trial as used once it actually starts (api/_trial.ts).
        ...(trialEligible
          ? {
              subscription_data: {
                trial_period_days: TRIAL_DAYS,
                metadata: { trial_email_hash: trialEmailHash(auth.email) },
              },
            }
          : {}),
        ui_mode: "elements",
        // Only card (which covers Apple Pay/Google Pay as wallet buttons on the
        // Payment Element) — not the full dynamic set (Cash App Pay, Klarna, etc).
        payment_method_types: ["card"],
        managed_payments: { enabled: false },
        return_url: `${webOrigin(req)}/pricing`,
      },
      // A double-click sends two identical requests: within the same minute
      // they share a key, so Stripe hands both the one session rather than
      // opening two. The minute keeps a later, deliberate retry from being
      // answered with a session that has since expired or been paid.
      {
        idempotencyKey: `checkout-${auth.userId}-${trialEligible ? "trial" : "paid"}-${idempotencyMinute()}`,
      },
    );

    if (!session.client_secret) {
      console.error(`checkout session ${session.id} created with no client_secret`);
      return res
        .status(500)
        .json({ error: "Could not start subscription payment" });
    }

    return res.status(200).json({ clientSecret: session.client_secret });
  } catch (error) {
    console.error("create-subscription failed:", error);
    return res.status(500).json({ error: "Could not start subscription" });
  }
}

// Starts an in-app "update payment method" flow: the client mounts the
// Payment Element against this Checkout Session's client secret and confirms
// it. The webhook (checkout.session.completed, mode "setup") is what actually
// attaches the resulting payment method as the default — see stripe-webhook.ts.
async function createSetupIntent(
  req: VercelRequest,
  res: VercelResponse,
  auth: { userId: string; email: string },
) {
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error("STRIPE_SECRET_KEY must be set");
    return res.status(500).json({ error: "Billing is not configured" });
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

    const customerId = row?.stripe_customer_id ?? null;
    if (!customerId) {
      return res.status(400).json({ error: "No billing account found" });
    }

    // Managed Payments (enabled by default on this account) only supports
    // mode: "subscription" and mode: "payment" — opt out for this session so
    // mode: "setup" is accepted.
    const session = await stripeClient().checkout.sessions.create({
      customer: customerId,
      mode: "setup",
      ui_mode: "elements",
      currency: "usd",
      // Only card (which covers Apple Pay/Google Pay as wallet buttons on the
      // Payment Element) — not the full dynamic set (Cash App Pay, Klarna, etc).
      payment_method_types: ["card"],
      managed_payments: { enabled: false },
      return_url: `${webOrigin(req)}/billing`,
    });

    if (!session.client_secret) {
      console.error(`checkout session ${session.id} created with no client_secret`);
      return res
        .status(500)
        .json({ error: "Could not start payment method update" });
    }

    return res.status(200).json({ clientSecret: session.client_secret });
  } catch (error) {
    console.error("create-setup-intent failed:", error);
    return res
      .status(500)
      .json({ error: "Could not start payment method update" });
  }
}

// Soft-cancel (or undo a soft-cancel): flips cancel_at_period_end only.
// Access continues until the current period ends either way — matches the
// "Cancel anytime" copy on the pricing page. The webhook, not this response,
// is what updates entitlements.subscription_status.
async function cancelSubscription(
  req: VercelRequest,
  res: VercelResponse,
  auth: { userId: string; email: string },
) {
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error("STRIPE_SECRET_KEY must be set");
    return res.status(500).json({ error: "Billing is not configured" });
  }

  const resume = req.body?.resume === true;

  try {
    const { data: row, error } = await serviceClient()
      .from("entitlements")
      .select("stripe_subscription_id")
      .eq("user_id", auth.userId)
      .maybeSingle();
    if (error) {
      console.error("entitlements read failed:", error.message);
      return res.status(500).json({ error: "Could not load billing account" });
    }

    const subscriptionId = row?.stripe_subscription_id ?? null;
    if (!subscriptionId) {
      return res.status(400).json({ error: "No subscription found" });
    }

    const subscription = await stripeClient().subscriptions.update(subscriptionId, {
      cancel_at_period_end: !resume,
    });

    return res.status(200).json({
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
    });
  } catch (error) {
    console.error("cancel-subscription failed:", error);
    return res
      .status(500)
      .json({ error: "Could not update your subscription" });
  }
}

// Combines plan, billing-summary, create-subscription, create-setup-intent, and
// cancel-subscription under one route — Vercel's Hobby plan caps deployments
// at 12 Serverless Functions.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleCors(req, res)) return;
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (req.method === "GET" && req.query.action === "plan") return getPlan(res);

  const auth = await requireAuth(req, res);
  if (!auth) return;

  if (req.method === "GET") return getBillingSummary(res, auth);

  const action = req.query.action;
  if (action === "create-subscription") return createSubscription(req, res, auth);
  if (action === "create-setup-intent") return createSetupIntent(req, res, auth);
  if (action === "cancel-subscription") return cancelSubscription(req, res, auth);
  return res.status(400).json({ error: "Invalid or missing action" });
}
