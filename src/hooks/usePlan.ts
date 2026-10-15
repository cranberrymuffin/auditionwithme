import { useEffect, useState } from "react";
import type { Plan } from "../lib/plan";

// One fetch per page load, shared by every caller — the price only changes
// on a redeploy.
let planRequest: Promise<Plan | null> | null = null;

function fetchPlan(): Promise<Plan | null> {
  planRequest ??= fetch("/api/billing?action=plan")
    .then((response) => (response.ok ? (response.json() as Promise<Plan>) : null))
    .catch(() => null)
    .then((plan) => {
      // Let a later mount retry instead of caching a failure for the session.
      if (!plan) planRequest = null;
      return plan;
    });
  return planRequest;
}

/** The live Audition Plus price from Stripe (api/billing.ts getPlan). Null
 * while loading, or if Stripe couldn't be reached. */
export function usePlan(): Plan | null {
  const [plan, setPlan] = useState<Plan | null>(null);

  useEffect(() => {
    let active = true;
    fetchPlan().then((result) => {
      if (active) setPlan(result);
    });
    return () => {
      active = false;
    };
  }, []);

  return plan;
}
