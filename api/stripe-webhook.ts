import type { VercelRequest, VercelResponse } from "@vercel/node";
import type Stripe from "stripe";
import type { Entitlement } from "../src/types.js";
import { serviceClient } from "./_supabase.js";
import { stripeClient } from "./_stripe.js";
import { isTrialEmailHash, recordTrialUse } from "./_trial.js";

// Signature verification needs the exact bytes Stripe signed, so Vercel must
// not parse the body for us.
export const config = {
  api: {
    bodyParser: false,
  },
};

// Webhooks are the sole writer of subscription state (plan Principle 3).

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
 * handle, unlike stripe_subscription_id.
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

// How much a subscription in this state should win over the customer's
// others when deciding what the row says: one that grants access, then one
// in payment trouble, then anything that never started or has ended.
function statusRank(status: Stripe.Subscription.Status): number {
  const mapped = mapStatus(status);
  if (mapped === "active") return 0;
  if (mapped === "past_due") return 1;
  return 2;
}

/**
 * The subscription the customer's row should reflect, read from Stripe now.
 * An event only carries a snapshot from when it was sent, and Stripe retries
 * and reorders deliveries — so a late event for a canceled subscription must
 * not overwrite the one that replaced it, and a stale "active" must not
 * bring a canceled one back. Asking for the current list makes every
 * delivery, in any order, write the same answer (plan Pre-mortem 2). With
 * several subscriptions on one customer, the best-placed wins (statusRank),
 * then the newest. Null when the customer has none, or is gone from Stripe.
 */
async function currentSubscription(
  customerId: string,
): Promise<Stripe.Subscription | null> {
  let subscriptions: Stripe.Subscription[];
  try {
    const list = await stripeClient().subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 20,
    });
    subscriptions = list.data;
  } catch (error) {
    // A deleted account's customer (api/account.ts) still gets its
    // subscription's final events.
    if ((error as { code?: unknown } | null)?.code === "resource_missing") return null;
    throw error;
  }
  return (
    [...subscriptions].sort(
      (a, b) => statusRank(a.status) - statusRank(b.status) || b.created - a.created,
    )[0] ?? null
  );
}

/** Brings the customer's row in line with Stripe; returns a log summary. */
async function syncCustomer(
  customerId: string,
  eventSubscriptionId: string,
): Promise<string> {
  const subscription = await currentSubscription(customerId);
  if (!subscription) {
    // Nothing left in Stripe to read: the subscription the event is about
    // has ended along with everything else.
    await writeState(customerId, {
      subscription_status: "canceled",
      stripe_subscription_id: eventSubscriptionId,
    });
    return "no subscriptions in stripe -> canceled";
  }
  const status = mapStatus(subscription.status);
  await writeState(customerId, {
    subscription_status: status,
    stripe_subscription_id: subscription.id,
    current_period_end: periodEnd(subscription),
  });
  return `${subscription.id} stripe status ${subscription.status} -> ${status}, period_end ${periodEnd(subscription)}`;
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
    console.error("stripe webhook missing signature header");
    return res.status(400).json({ error: "Missing stripe-signature header" });
  }

  let event: Stripe.Event;
  try {
    const rawBody = await readRawBody(req);
    event = stripeClient().webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (error) {
    console.error("stripe webhook signature verification failed:", error);
    return res.status(400).json({ error: "Invalid signature" });
  }

  try {
    switch (event.type) {
      // Every subscription and invoice event is handled the same way: the
      // event says which customer changed, and the row is then written from
      // what Stripe holds for that customer right now (syncCustomer) — never
      // from the event's own snapshot, so it doesn't matter which of
      // "created", "updated" and "deleted" lands last, or how late.
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const subscription = event.data.object;
        const customerId = idOf(subscription.customer);
        if (!customerId) break;
        // A trial that has started is used, for this email, for good — see
        // api/_trial.ts. trial_start and the metadata are both set when the
        // subscription is created, so the snapshot is enough here.
        const trialEmailHash = subscription.metadata?.trial_email_hash;
        if (
          event.type === "customer.subscription.created" &&
          subscription.trial_start &&
          isTrialEmailHash(trialEmailHash)
        ) {
          await recordTrialUse(trialEmailHash);
        }
        const summary = await syncCustomer(customerId, subscription.id);
        console.log(
          `webhook ${event.type} ${event.id}: customer ${customerId} ${summary}`,
        );
        break;
      }

      case "invoice.payment_succeeded": {
        const invoice = event.data.object;
        const customerId = idOf(invoice.customer);
        const subscriptionId = idOf(
          invoice.parent?.subscription_details?.subscription,
        );
        if (!customerId || !subscriptionId) {
          console.log(
            `webhook ${event.type} ${event.id}: not a subscription invoice, ignored`,
          );
          break;
        }
        const summary = await syncCustomer(customerId, subscriptionId);
        console.log(
          `webhook ${event.type} ${event.id}: customer ${customerId} ${summary}`,
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
        const retrieved = await stripeClient().checkout.sessions.retrieve(session.id, {
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

        await stripeClient().customers.update(customerId, {
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
            await stripeClient().subscriptions.update(subscriptionId, {
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
        // Nothing is written here, but access does not carry on through
        // Stripe's retries: the failure moves the subscription to past_due,
        // the customer.subscription.updated that follows caches that
        // (mapStatus), and hasPlanAccess (src/lib/plan.ts) accepts only
        // "active". So access stops at the first failed payment and returns
        // when a retry succeeds (invoice.payment_succeeded).
        const invoice = event.data.object;
        console.log(
          `webhook ${event.type} ${event.id}: customer ${idOf(invoice.customer)} -> nothing written here`,
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
