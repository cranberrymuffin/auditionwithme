import type { VercelRequest, VercelResponse } from "@vercel/node";
import { timingSafeEqual } from "node:crypto";
import { syncAppleSubscription } from "./_revenuecat.js";

// RevenueCat posts every App Store subscription change here (purchase,
// renewal, cancellation, expiry, refund, transfer). The event only says
// which users changed; their state is re-read from RevenueCat in
// syncAppleSubscription, so the event type itself doesn't matter.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RevenueCatEvent = {
  id?: string;
  type?: string;
  app_user_id?: string;
  transferred_from?: string[];
  transferred_to?: string[];
};

function authorized(header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const given = Buffer.from(header);
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // The exact value set as the webhook's Authorization header in the
  // RevenueCat dashboard.
  const secret = process.env.REVENUECAT_WEBHOOK_AUTH;
  if (!secret) {
    console.error("REVENUECAT_WEBHOOK_AUTH must be set");
    return res.status(500).json({ error: "Billing is not configured" });
  }
  if (!authorized(req.headers.authorization, secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const event = (req.body as { event?: RevenueCatEvent } | undefined)?.event;
  if (!event) return res.status(400).json({ error: "Missing event" });

  // Anonymous RevenueCat IDs ($RCAnonymousID:…) never belong to a signed-in
  // user, and TEST events carry a made-up one.
  const userIds = [
    ...new Set([
      event.app_user_id,
      ...(event.transferred_from ?? []),
      ...(event.transferred_to ?? []),
    ]),
  ].filter((id): id is string => !!id && UUID.test(id));

  try {
    for (const userId of userIds) {
      const active = await syncAppleSubscription(userId);
      console.log(`revenuecat ${event.type} ${event.id}: user ${userId} -> ${active ? "active" : "inactive"}`);
    }
  } catch (error) {
    // A 5xx makes RevenueCat retry with backoff.
    console.error(`revenuecat ${event.type} ${event.id} failed:`, error);
    return res.status(500).json({ error: "Sync failed" });
  }
  return res.status(200).json({ received: true });
}
