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
    throw new Error(
      "VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set",
    );
  }
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "", {
  apiVersion: "2025-03-31.basil",
});

function clientSecretOf(subscription: Stripe.Subscription): string | null {
  const invoice = subscription.latest_invoice;
  if (!invoice || typeof invoice === "string") return null;
  const paymentIntent = invoice.payment_intent;
  if (!paymentIntent || typeof paymentIntent === "string") return null;
  return paymentIntent.client_secret;
}

// Read-only view of the caller's Stripe billing state, fetched live so the
// account/billing page can never drift from what Stripe actually has —
// nothing here is cached in Supabase.
async function getBillingSummary(
  req: VercelRequest,
  res: VercelResponse,
  auth: { userId: string },
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
      return res.status(200).json({ subscription: null, invoices: [] });
    }

    const subscriptionId = row?.stripe_subscription_id ?? null;
    let subscription: Stripe.Subscription | null = null;
    if (subscriptionId) {
      try {
        subscription = await stripe.subscriptions.retrieve(subscriptionId, {
          expand: ["default_payment_method"],
        });
      } catch (err) {
        // Subscription may have been deleted on Stripe's side; treat as none.
        console.error(`subscription ${subscriptionId} retrieve failed:`, err);
      }
    }

    // The customer's default_payment_method is the field set-default-payment-
    // method.ts can always update, so it's the freshest source once a user
    // has ever changed their card. Subscriptions created via a Checkout
    // Session with Managed Payments reject changes to their own
    // default_payment_method entirely, so that field can go stale forever —
    // fall back to it only when the customer has never set one (e.g. a
    // day-one subscriber who hasn't used "update payment method" yet).
    const customer = await stripe.customers.retrieve(customerId, {
      expand: ["invoice_settings.default_payment_method"],
    });
    const customerDefault =
      !("deleted" in customer && customer.deleted) &&
      customer.invoice_settings.default_payment_method &&
      typeof customer.invoice_settings.default_payment_method !== "string"
        ? customer.invoice_settings.default_payment_method
        : null;

    const subscriptionDefault =
      subscription?.default_payment_method &&
      typeof subscription.default_payment_method !== "string"
        ? subscription.default_payment_method
        : null;

    const paymentMethod = customerDefault ?? subscriptionDefault;

    const invoices = await stripe.invoices.list({
      customer: customerId,
      limit: 12,
    });

    return res.status(200).json({
      subscription: subscription
        ? {
            status: subscription.status,
            cancelAtPeriodEnd: subscription.cancel_at_period_end,
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

// Starts (or resumes) a subscription for the single $7/month plan and returns
// a PaymentIntent client secret for the embedded Payment Element to confirm.
// Never writes subscription_status — only the webhook does that (plan
// Principle 3).
async function createSubscription(
  req: VercelRequest,
  res: VercelResponse,
  auth: { userId: string },
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
        console.error(
          "entitlements stripe_customer_id write failed:",
          writeError.message,
        );
        return res
          .status(500)
          .json({ error: "Could not save billing account" });
      }
      console.log(
        `stripe customer created ${customerId} for user ${auth.userId}`,
      );
    }

    // Reuse an abandoned in-progress attempt instead of creating a duplicate
    // subscription every time the user retries.
    const existing = await stripe.subscriptions.list({
      customer: customerId,
      status: "incomplete",
      expand: ["data.latest_invoice.payment_intent"],
      limit: 1,
    });
    const reusable = existing.data[0];
    const reusableSecret = reusable ? clientSecretOf(reusable) : null;
    if (reusable && reusableSecret) {
      return res.status(200).json({ clientSecret: reusableSecret });
    }

    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      payment_behavior: "default_incomplete",
      payment_settings: {
        payment_method_types: ["card"],
        save_default_payment_method: "on_subscription",
      },
      expand: ["latest_invoice.payment_intent"],
    });

    const clientSecret = clientSecretOf(subscription);
    if (!clientSecret) {
      console.error(
        `subscription ${subscription.id} created with no payment_intent client_secret`,
      );
      return res
        .status(500)
        .json({ error: "Could not start subscription payment" });
    }

    return res.status(200).json({ clientSecret });
  } catch (error) {
    console.error("create-subscription failed:", error);
    const message = error instanceof Error ? error.message : String(error);
    return res
      .status(500)
      .json({ error: `Could not start subscription: ${message}` });
  }
}

// Starts an in-app "update payment method" flow: the client mounts the
// Payment Element against this SetupIntent's client secret, confirms it, then
// calls this endpoint again with action=set-default-payment-method.
async function createSetupIntent(
  req: VercelRequest,
  res: VercelResponse,
  auth: { userId: string },
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

    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      usage: "off_session",
      payment_method_types: ["card"],
    });

    return res.status(200).json({ clientSecret: setupIntent.client_secret });
  } catch (error) {
    console.error("create-setup-intent failed:", error);
    return res
      .status(500)
      .json({ error: "Could not start payment method update" });
  }
}

// Called after the client confirms a SetupIntent (action=create-setup-intent)
// client-side. Attaches the resulting payment method as the default for both
// the customer's invoices and their active subscription.
async function setDefaultPaymentMethod(
  req: VercelRequest,
  res: VercelResponse,
  auth: { userId: string },
) {
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error("STRIPE_SECRET_KEY must be set");
    return res.status(500).json({ error: "Billing is not configured" });
  }

  const paymentMethodId = req.body?.paymentMethodId;
  if (typeof paymentMethodId !== "string" || !paymentMethodId) {
    return res.status(400).json({ error: "Missing paymentMethodId" });
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
      return res.status(400).json({ error: "No billing account found" });
    }

    // Confirm the payment method actually belongs to this customer before
    // trusting a client-supplied id.
    const paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId);
    if (paymentMethod.customer !== customerId) {
      return res.status(403).json({ error: "Payment method does not belong to this account" });
    }

    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });

    const subscriptionId = row?.stripe_subscription_id ?? null;
    if (subscriptionId) {
      try {
        await stripe.subscriptions.update(subscriptionId, {
          default_payment_method: paymentMethodId,
        });
      } catch (err) {
        // Subscriptions created via a Checkout Session with Managed Payments
        // reject this field outright — Stripe bills the customer's default
        // for those instead, and that update above already succeeded, so
        // this isn't fatal.
        console.error(
          `subscription ${subscriptionId} default_payment_method update failed, relying on customer-level default:`,
          err,
        );
      }
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("set-default-payment-method failed:", error);
    return res
      .status(500)
      .json({ error: "Could not update payment method" });
  }
}

// Soft-cancel (or undo a soft-cancel): flips cancel_at_period_end only.
// Access continues until the current period ends either way — matches the
// "Cancel anytime" copy on the pricing page. The webhook, not this response,
// is what updates entitlements.subscription_status.
async function cancelSubscription(
  req: VercelRequest,
  res: VercelResponse,
  auth: { userId: string },
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

    const subscription = await stripe.subscriptions.update(subscriptionId, {
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

// Combines billing-summary, create-subscription, create-setup-intent,
// set-default-payment-method, and cancel-subscription under one route —
// Vercel's Hobby plan caps deployments at 12 Serverless Functions.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;

  if (req.method === "GET") return getBillingSummary(req, res, auth);

  const action = req.query.action;
  if (action === "create-subscription") return createSubscription(req, res, auth);
  if (action === "create-setup-intent") return createSetupIntent(req, res, auth);
  if (action === "set-default-payment-method")
    return setDefaultPaymentMethod(req, res, auth);
  if (action === "cancel-subscription") return cancelSubscription(req, res, auth);
  return res.status(400).json({ error: "Invalid or missing action" });
}
