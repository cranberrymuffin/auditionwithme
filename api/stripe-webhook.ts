import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import type { Entitlement } from "../src/types.js";

// Signature verification needs the exact bytes Stripe signed, so Vercel must
// not parse the body for us (precedent for route-level config: parse-script.ts).
export const config = {
  api: {
    bodyParser: false,
  },
};

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Same service-role client pattern as api/_entitlement.ts. Webhooks are the
// sole writer of subscription state (plan Principle 3).
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
  apiVersion: "2026-07-29.dahlia",
});

async function readRawBody(
  req: VercelRequest & { bodyRaw?: Buffer },
): Promise<Buffer> {
  if (req.bodyRaw) {
    return req.bodyRaw;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

type SubscriptionStatus = Entitlement["subscription_status"];

/** Stripe's subscription status → our cached status. */
function mapStatus(status: Stripe.Subscription.Status): SubscriptionStatus {
  if (status === "active" || status === "trialing") return "active";
  if (status === "past_due" || status === "unpaid") return "past_due";
  // Never successfully paid — distinct from an actual cancellation.
  if (status === "incomplete" || status === "incomplete_expired") return "free";
  return "canceled";
}

function periodEnd(subscription: Stripe.Subscription): string | null {
  const end = subscription.items.data[0]?.current_period_end;
  return end ? new Date(end * 1000).toISOString() : null;
}

function idOf(
  value: string | { id: string } | null | undefined,
): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

/**
 * Writes the row matched by stripe_customer_id — present on every event we
 * handle, unlike stripe_subscription_id. State is always derived fresh from
 * the subscription object rather than incrementally patched, so replays and
 * out-of-order deliveries converge (plan Pre-mortem 2).
 */
async function writeState(
  customerId: string,
  state: Partial<
    Pick<
      Entitlement,
      "subscription_status" | "stripe_subscription_id" | "current_period_end"
    >
  >,
): Promise<void> {
  const { error } = await serviceClient()
    .from("entitlements")
    .update({ ...state, updated_at: new Date().toISOString() })
    .eq("stripe_customer_id", customerId);
  if (error) throw new Error(`entitlements update failed: ${error.message}`);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret || !process.env.STRIPE_SECRET_KEY) {
    console.error("STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET must be set");
    return res.status(500).json({ error: "Billing is not configured" });
  }

  const signature =
    typeof req.headers["stripe-signature"] === "string"
      ? req.headers["stripe-signature"]
      : typeof req.headers["Stripe-Signature"] === "string"
        ? req.headers["Stripe-Signature"]
        : null;
  if (!signature) {
    console.error("stripe webhook missing signature header", req.headers);
    return res.status(400).json({ error: "Missing stripe-signature header" });
  }

  let event: Stripe.Event;
  try {
    const rawBody = await readRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (error) {
    console.error("stripe webhook signature verification failed:", error);
    return res
      .status(400)
      .json({
        error: `Invalid signature: ${error instanceof Error ? error.message : String(error)}`,
      });
  }

  try {
    switch (event.type) {
      // A subscription created via a Checkout Session (api/billing.ts
      // createSubscription) only exists once the session is confirmed, but
      // still fires "created" and "updated" in close succession as the
      // subscription's PaymentIntent settles. Both are handled identically —
      // state is always derived fresh from the subscription object, so it
      // doesn't matter which event lands last.
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const subscription = event.data.object;
        const customerId = idOf(subscription.customer);
        if (!customerId) break;
        const status = mapStatus(subscription.status);
        await writeState(customerId, {
          subscription_status: status,
          stripe_subscription_id: subscription.id,
          current_period_end: periodEnd(subscription),
        });
        console.log(
          `webhook ${event.type} ${event.id}: customer ${customerId} stripe status ${subscription.status} -> ${status}, period_end ${periodEnd(subscription)}`,
        );
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object;
        const customerId = idOf(subscription.customer);
        if (!customerId) break;
        await writeState(customerId, {
          subscription_status: "canceled",
          stripe_subscription_id: subscription.id,
          current_period_end: periodEnd(subscription),
        });
        console.log(
          `webhook ${event.type} ${event.id}: customer ${customerId} -> canceled`,
        );
        break;
      }

      case "invoice.payment_succeeded": {
        const invoice = event.data.object;
        const customerId = idOf(invoice.customer);
        const subscriptionId = idOf(invoice.subscription);
        if (!customerId || !subscriptionId) {
          console.log(
            `webhook ${event.type} ${event.id}: not a subscription invoice, ignored`,
          );
          break;
        }
        const subscription =
          await stripe.subscriptions.retrieve(subscriptionId);
        const status = mapStatus(subscription.status);
        await writeState(customerId, {
          subscription_status: status,
          stripe_subscription_id: subscription.id,
          current_period_end: periodEnd(subscription),
        });
        console.log(
          `webhook ${event.type} ${event.id}: customer ${customerId} -> ${status}, period_end ${periodEnd(subscription)}`,
        );
        break;
      }

      case "checkout.session.completed": {
        const session = event.data.object;
        if (session.mode !== "setup") {
          // Subscription-mode completion is already fully covered by the
          // customer.subscription.created/updated and invoice.payment_succeeded
          // handlers above, since createSubscription always passes our own
          // pre-created customer into the session.
          console.log(
            `webhook ${event.type} ${event.id}: mode ${session.mode}, no setup handling needed`,
          );
          break;
        }

        const customerId = idOf(session.customer);
        if (!customerId) break;

        // The session payload doesn't expand setup_intent by default —
        // retrieve it to get the confirmed payment method.
        const retrieved = await stripe.checkout.sessions.retrieve(session.id, {
          expand: ["setup_intent"],
        });
        const setupIntent = retrieved.setup_intent;
        const paymentMethodId =
          setupIntent && typeof setupIntent !== "string"
            ? idOf(setupIntent.payment_method)
            : null;
        if (!paymentMethodId) {
          console.error(
            `webhook ${event.type} ${event.id}: no payment_method on setup_intent`,
          );
          break;
        }

        await stripe.customers.update(customerId, {
          invoice_settings: { default_payment_method: paymentMethodId },
        });

        const { data: row, error } = await serviceClient()
          .from("entitlements")
          .select("stripe_subscription_id")
          .eq("stripe_customer_id", customerId)
          .maybeSingle();
        if (error) throw new Error(`entitlements read failed: ${error.message}`);

        const subscriptionId = row?.stripe_subscription_id ?? null;
        if (subscriptionId) {
          try {
            await stripe.subscriptions.update(subscriptionId, {
              default_payment_method: paymentMethodId,
            });
          } catch (err) {
            // Subscriptions created via a Checkout Session with Managed
            // Payments reject this field outright — Stripe bills the
            // customer's default for those instead, and the customer-level
            // update above already succeeded, so this isn't fatal.
            console.error(
              `subscription ${subscriptionId} default_payment_method update failed, relying on customer-level default:`,
              err,
            );
          }
        }

        console.log(
          `webhook ${event.type} ${event.id}: customer ${customerId} default payment method -> ${paymentMethodId}`,
        );
        break;
      }

      case "invoice.payment_failed": {
        // No status change here — access persists through Stripe's dunning
        // grace period; only a terminal subscription event revokes it.
        const invoice = event.data.object;
        console.log(
          `webhook ${event.type} ${event.id}: customer ${idOf(invoice.customer)} -> no change (grace period)`,
        );
        break;
      }

      default:
        console.log(`webhook ${event.type} ${event.id}: unhandled, ignored`);
    }
  } catch (error) {
    // 500 tells Stripe to retry; handlers are idempotent so a retry is safe.
    console.error(`webhook ${event.type} ${event.id} failed:`, error);
    return res.status(500).json({ error: "Webhook processing failed" });
  }

  return res.status(200).json({ received: true });
}
