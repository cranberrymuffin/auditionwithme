import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import type { Entitlement } from "../src/types.js";
import { IS_BETA_TESTING } from "../src/lib/beta.js";
import { hasPlanAccess } from "../src/lib/plan.js";

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const grantSecret = process.env.REHEARSAL_GRANT_SECRET;

// Service-role client: bypasses RLS, used for every server-side entitlement
// read/write. Never expose serviceRoleKey to the client.
function serviceClient() {
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Verifies the Supabase JWT on the request (Authorization: Bearer <token>,
 * attached client-side by src/lib/api.ts). Sends 401 and returns null if
 * missing/invalid — callers should `return` immediately when this is null.
 */
export async function requireAuth(
  req: VercelRequest,
  res: VercelResponse
): Promise<{ userId: string; email: string } | null> {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: "Missing or invalid Authorization header" });
    return null;
  }
  const { data, error } = await serviceClient().auth.getUser(token);
  if (error || !data.user || !data.user.email) {
    res.status(401).json({ error: "Invalid or expired session" });
    return null;
  }
  // Fail-closed fallback: the DB trigger normally seeds this row on signup,
  // but if it didn't fire, create it now rather than permanently locking
  // the user out (plan Risks table: "DB trigger silently fails").
  await serviceClient().from("entitlements").upsert(
    { user_id: data.user.id },
    { onConflict: "user_id", ignoreDuplicates: true }
  );
  return { userId: data.user.id, email: data.user.email };
}

const DEFAULT_RATE_LIMIT = {
  bucket: "default",
  maxPerWindow: 200,
  windowSeconds: 60 * 60,
};

/**
 * Outside beta, sends 402 and returns false unless the user has an active
 * subscription or trial. The webhook caches Stripe's "trialing" as "active".
 */
async function requirePlan(userId: string, res: VercelResponse): Promise<boolean> {
  if (IS_BETA_TESTING) return true;
  const { data, error } = await serviceClient()
    .from("entitlements")
    .select("subscription_status")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    console.error("entitlements read failed:", error.message);
    // Fail closed (Principle 4), same as the rate limit below.
    res.status(500).json({ error: "Could not check entitlement" });
    return false;
  }
  const status = (data as Pick<Entitlement, "subscription_status"> | null)?.subscription_status;
  if (!hasPlanAccess(status)) {
    res.status(402).json({
      error: "An active subscription or free trial is required",
      reason: "subscription_required",
    });
    return false;
  }
  return true;
}

/**
 * requireAuth, plus — outside beta — an active subscription or trial, plus a
 * per-user, per-feature sliding-window rate limit. Every caller is a paid
 * rehearsal API (TTS, STS, casting, Scribe), and rehearsing a saved script
 * never goes through issueRehearsalGrant, so this is what keeps a lapsed
 * user from rehearsing old scripts. Keeping buckets separate prevents normal
 * TTS playback from blocking casting or Scribe token creation. Sends
 * 401/402/429 and returns null on rejection.
 */
export async function requireAuthRateLimited(
  req: VercelRequest,
  res: VercelResponse,
  options: { bucket?: string; maxPerWindow?: number; windowSeconds?: number } = {}
): Promise<{ userId: string } | null> {
  const auth = await requireAuth(req, res);
  if (!auth) return null;
  // Before the rate limit, so a rejected call doesn't use up the bucket.
  if (!(await requirePlan(auth.userId, res))) return null;

  const bucket = options.bucket ?? DEFAULT_RATE_LIMIT.bucket;
  const maxPerWindow = options.maxPerWindow ?? DEFAULT_RATE_LIMIT.maxPerWindow;
  const windowSeconds = options.windowSeconds ?? DEFAULT_RATE_LIMIT.windowSeconds;

  const { data: allowed, error } = await serviceClient().rpc("check_rate_limit", {
    p_user_id: auth.userId,
    p_bucket: bucket,
    p_window_seconds: windowSeconds,
    p_max_calls: maxPerWindow,
  });

  if (error) {
    console.error("check_rate_limit RPC failed:", error.message);
    // Fail closed (Principle 4): if we can't verify the rate limit, block.
    res.status(500).json({ error: "Could not verify rate limit" });
    return null;
  }
  if (!allowed) {
    res.setHeader("Retry-After", String(windowSeconds));
    res.status(429).json({ error: "Rate limit exceeded. Please slow down.", retryAfterSeconds: windowSeconds });
    return null;
  }
  return auth;
}

const GRANT_TTL_SECONDS = 60 * 60; // 1 hour — see plan for reasoning

type GrantPayload = { userId: string; exp: number };

function signGrant(payload: GrantPayload): string {
  if (!grantSecret) throw new Error("REHEARSAL_GRANT_SECRET must be set");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", grantSecret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function verifyGrant(token: string): GrantPayload | null {
  if (!grantSecret) throw new Error("REHEARSAL_GRANT_SECRET must be set");
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  const expected = crypto.createHmac("sha256", grantSecret).update(body).digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  let payload: GrantPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload.userId !== "string" || typeof payload.exp !== "number") return null;
  if (payload.exp < Date.now() / 1000) return null;
  return payload;
}

/**
 * The single point of subscription enforcement. Called once per upload
 * (api/start-rehearsal.ts), never per API call — see plan Decision 2.
 * Returns a signed grant on success, or null (with 402 already sent) if the
 * user has no active subscription. A free trial counts as active — the
 * webhook caches Stripe's "trialing" as "active".
 */
export async function issueRehearsalGrant(
  userId: string,
  res: VercelResponse
): Promise<string | null> {
  // Beta: requirePlan lets everyone through — see src/lib/beta.ts and
  // FeedbackGate.tsx for what replaces the paywall.
  if (!(await requirePlan(userId, res))) return null;
  return signGrant({ userId, exp: Math.floor(Date.now() / 1000) + GRANT_TTL_SECONDS });
}

/**
 * Verify-only check for parse-script/parse-pages: confirms the caller holds
 * a valid, unexpired grant issued to them. Never increments anything — every
 * parallel chunk call, retry, and bilingual re-parse for the same upload
 * reuses the same grant (plan Decision 2 / Principle 5).
 */
export async function requireRehearsalGrant(
  req: VercelRequest,
  res: VercelResponse
): Promise<{ userId: string } | null> {
  const auth = await requireAuth(req, res);
  if (!auth) return null;

  const grantHeader = req.headers["x-rehearsal-grant"];
  const grantToken = Array.isArray(grantHeader) ? grantHeader[0] : grantHeader;
  if (!grantToken) {
    res.status(403).json({ error: "Missing rehearsal grant", reason: "grant_missing" });
    return null;
  }

  const payload = verifyGrant(grantToken);
  if (!payload) {
    res.status(403).json({ error: "Rehearsal grant expired or invalid", reason: "grant_invalid" });
    return null;
  }
  if (payload.userId !== auth.userId) {
    res.status(403).json({ error: "Rehearsal grant does not belong to this user", reason: "grant_invalid" });
    return null;
  }
  return auth;
}
