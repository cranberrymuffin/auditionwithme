import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAuth, issueRehearsalGrant } from "./_entitlement.js";

// Called once per upload, before any parse-script/parse-pages calls. Issues
// a signed grant that every downstream call for this same upload (parallel
// scanned-PDF chunks, retries, the bilingual re-parse) reuses read-only —
// see api/_entitlement.ts and the plan's Decision 2.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;

  const grant = await issueRehearsalGrant(auth.userId, res);
  if (!grant) return; // 402 already sent

  return res.status(200).json({ grant });
}
