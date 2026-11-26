import type { VercelRequest, VercelResponse } from "@vercel/node";
import crypto from "node:crypto";
import type { Entitlement } from "../src/types.js";
import { IS_BETA_TESTING } from "../src/lib/beta.js";
import { hasPlanAccess } from "../src/lib/plan.js";
import { serviceClient } from "./_supabase.js";

const grantSecret = process.env.REHEARSAL_GRANT_SECRET;

// Users whose entitlements row this warm instance has already confirmed.
// The row only ever goes away with the account itself, so one confirmation
// per instance saves a write on every later request. Bounded so a
// long-lived instance can't grow it without limit.
const ensuredEntitlements = new Set<string>();
const MAX_ENSURED_ENTITLEMENTS = 5000;

// Fail-closed fallback: the DB trigger normally seeds this row on signup,
// but if it didn't fire, create it now rather than permanently locking
// the user out (plan Risks table: "DB trigger silently fails").
async function ensureEntitlementRow(userId: string): Promise<void> {
  if (ensuredEntitlements.has(userId)) return;
  const { error } = await serviceClient().from("entitlements").upsert(
    { user_id: userId },
    { onConflict: "user_id", ignoreDuplicates: true }
  );
  if (error) {
    // Not fatal here: routes that need the row fail closed on their own read.
    console.error("entitlements seed upsert failed:", error.message);
    return;
  }
  if (ensuredEntitlements.size >= MAX_ENSURED_ENTITLEMENTS) ensuredEntitlements.clear();
  ensuredEntitlements.add(userId);
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
  await ensureEntitlementRow(data.user.id);
  return { userId: data.user.id, email: data.user.email };
}

export type RateLimit = { bucket: string; maxPerWindow: number; windowSeconds: number };

const DEFAULT_RATE_LIMIT: RateLimit = {
  bucket: "default",
  maxPerWindow: 200,
  windowSeconds: 60 * 60,
};

/**
 * Counts this call against the user's bucket (check_rate_limit: a fixed
 * window that restarts once it has run out, not a sliding one). Sends
 * 429/500 and returns false when the call must not go ahead.
 */
async function enforceRateLimit(
  userId: string,
  res: VercelResponse,
  { bucket, maxPerWindow, windowSeconds }: RateLimit
): Promise<boolean> {
  const { data: allowed, error } = await serviceClient().rpc("check_rate_limit", {
    p_user_id: userId,
    p_bucket: bucket,
    p_window_seconds: windowSeconds,
    p_max_calls: maxPerWindow,
  });

  if (error) {
    console.error("check_rate_limit RPC failed:", error.message);
    // Fail closed (Principle 4): if we can't verify the rate limit, block.
    res.status(500).json({ error: "Could not verify rate limit" });
    return false;
  }
  if (!allowed) {
    console.warn(`rate limit hit: user ${userId} bucket ${bucket}`);
    res.setHeader("Retry-After", String(windowSeconds));
    res.status(429).json({ error: "Rate limit exceeded. Please slow down.", retryAfterSeconds: windowSeconds });
    return false;
  }
  return true;
}

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
 * per-user, per-feature fixed-window rate limit. Every caller is a paid
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

  if (!(await enforceRateLimit(auth.userId, res, { ...DEFAULT_RATE_LIMIT, ...options }))) {
    return null;
  }
  return auth;
}

// Grants are cheap to sign, but each one unlocks an hour of parse calls, so
// a script looping on this route shouldn't be able to mint them freely. An
// upload takes one; 60 an hour is far past any real use.
const GRANT_RATE_LIMIT: RateLimit = {
  bucket: "start-rehearsal",
  maxPerWindow: 60,
  windowSeconds: 60 * 60,
};

// Every parse call (parse-script and parse-pages alike) also counts against
// one daily allowance, so a client that stays just under the hourly limits
// still can't run model parses around the clock.
const PARSE_DAILY_RATE_LIMIT: RateLimit = {
  bucket: "parse-daily",
  maxPerWindow: 1000,
  windowSeconds: 24 * 60 * 60,
};

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
  const given = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch; a malformed grant is just
  // an invalid one.
  if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) return null;
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
 * user has no active subscription, or (429 sent) if they're requesting
 * grants in a loop. A free trial counts as active — the webhook caches
 * Stripe's "trialing" as "active".
 */
export async function issueRehearsalGrant(
  userId: string,
  res: VercelResponse
): Promise<string | null> {
  // Beta: requirePlan lets everyone through — see src/lib/beta.ts and
  // FeedbackGate.tsx for what replaces the paywall.
  if (!(await requirePlan(userId, res))) return null;
  if (!(await enforceRateLimit(userId, res, GRANT_RATE_LIMIT))) return null;
  return signGrant({ userId, exp: Math.floor(Date.now() / 1000) + GRANT_TTL_SECONDS });
}

/**
 * Check for parse-script/parse-pages: confirms the caller holds a valid,
 * unexpired grant issued to them — every parallel chunk call, retry, and
 * bilingual re-parse for the same upload reuses the same grant (plan
 * Decision 2 / Principle 5). The grant is never used up, so what bounds the
 * model spend behind it is `rateLimit` (the route's own hourly bucket) plus
 * the daily allowance all parse calls share. Sends 401/403/429 and returns
 * null on rejection.
 */
export async function requireRehearsalGrant(
  req: VercelRequest,
  res: VercelResponse,
  rateLimit: RateLimit
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
  // The hourly bucket first, so a call it rejects doesn't use up the day's.
  if (!(await enforceRateLimit(auth.userId, res, rateLimit))) return null;
  if (!(await enforceRateLimit(auth.userId, res, PARSE_DAILY_RATE_LIMIT))) return null;
  return auth;
}
