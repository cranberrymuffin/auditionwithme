import { useEffect, type ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useEntitlement } from "../hooks/useEntitlement";
import { IS_BETA_TESTING } from "../lib/beta";
import { hasPlanAccess } from "../lib/plan";
import { useToast } from "../lib/toast";

/**
 * Sends a user without an active subscription or trial to /pricing instead
 * of into a rehearsal whose voice calls would all 402. UX only — the real
 * boundary is requireAuthRateLimited / issueRehearsalGrant server-side.
 * Covers every way into /practice: a new upload, a re-upload of a saved
 * script, and "practice again" from My Auditions. Expects RequireAuth above.
 */
export default function RequirePlan({ children }: { children: ReactNode }) {
  const { entitlement, loading } = useEntitlement();
  const toast = useToast();
  const blocked =
    !IS_BETA_TESTING && !loading && !hasPlanAccess(entitlement?.subscription_status);

  useEffect(() => {
    if (blocked) toast("Start your free trial or subscribe to keep rehearsing.");
  }, [blocked, toast]);

  if (IS_BETA_TESTING) return <>{children}</>;
  if (loading) return <div className="cinematic-page auth-page" aria-busy="true" />;
  if (blocked) return <Navigate to="/pricing" replace />;

  return <>{children}</>;
}
