// The one Audition Plus plan. The price itself lives in Stripe
// (STRIPE_PRICE_ID) and is fetched live wherever it's shown — see
// api/billing.ts getPlan — so it can't drift from what users are charged.

/** Free-trial length for a customer's first subscription. */
export const TRIAL_DAYS = 7;

export type Plan = {
  /** Smallest currency unit, e.g. 999 for $9.99. */
  amount: number;
  currency: string;
  /** Stripe's recurring interval, e.g. "month". */
  interval: string;
  trialDays: number;
};

export function formatPlanPrice(plan: Pick<Plan, "amount" | "currency">): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: plan.currency.toUpperCase(),
    minimumFractionDigits: plan.amount % 100 === 0 ? 0 : 2,
  }).format(plan.amount / 100);
}

/** Subscription statuses that grant access. Stripe's "trialing" is cached
 * as "active" by the webhook (api/stripe-webhook.ts mapStatus). */
export function hasPlanAccess(status: string | null | undefined): boolean {
  return status === "active";
}
