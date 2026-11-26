import crypto from "node:crypto";
import { serviceClient } from "./_supabase.js";

// Deleting an account deletes its Stripe customer, and with it the
// subscription history trial eligibility is otherwise read from — so signing
// up again with the same email would earn a fresh free trial every time.
// trial_uses (see its migration) outlives the account: one row per email
// that has started a trial, keyed by a hash so the table holds no addresses.

/** The trial_uses key for an email: SHA-256 of it, trimmed and lowercased. */
export function trialEmailHash(email: string): string {
  return crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

export function isTrialEmailHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export async function emailHasUsedTrial(email: string): Promise<boolean> {
  const { data, error } = await serviceClient()
    .from("trial_uses")
    .select("email_hash")
    .eq("email_hash", trialEmailHash(email))
    .maybeSingle();
  if (error) throw new Error(`trial_uses read failed: ${error.message}`);
  return data !== null;
}

export async function recordTrialUse(emailHash: string): Promise<void> {
  const { error } = await serviceClient()
    .from("trial_uses")
    .upsert({ email_hash: emailHash }, { onConflict: "email_hash", ignoreDuplicates: true });
  if (error) throw new Error(`trial_uses write failed: ${error.message}`);
}
