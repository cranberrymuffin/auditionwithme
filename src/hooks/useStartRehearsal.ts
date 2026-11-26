import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../lib/toast";
import { ApiError } from "../lib/apiError";
import { requestRehearsalGrant } from "../lib/parseErrors";
import { findScriptByContentHash } from "../lib/scriptStore";
import { hashFile } from "../lib/scriptHash";
import { stashUpload } from "../lib/pendingUpload";

// Scanned PDFs are rendered to page images client-side (never uploaded whole),
// so the cap only guards browser memory.
const MAX_PDF_BYTES = 50 * 1024 * 1024;

/**
 * Takes a picked PDF to /practice: Home's upload, and step 1's Replace
 * script. Each start carries a fresh `session`, which Practice keys its flow
 * on, so a new script starts the flow over even from /practice itself.
 * `replace` swaps the current history entry (step 1 replacing its own
 * script) instead of adding one. Expects a signed-in user.
 */
export function useStartRehearsal() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();

  return useCallback(
    async (file: File, { replace = false }: { replace?: boolean } = {}) => {
      if (!user) return;
      if (file.type !== "application/pdf") {
        toast("That file isn't a PDF — try another one.");
        return;
      }
      if (file.size > MAX_PDF_BYTES) {
        toast("That PDF is over 50 MB. Compress it and try again.");
        return;
      }
      const session = crypto.randomUUID();

      // Re-uploading a script already parsed for this account should reuse
      // the stored steps instead of paying for another AI parse (and,
      // matching the My Account "practice again" path, shouldn't burn a
      // free session/rehearsal grant for it either).
      const contentHash = await hashFile(file);
      const existing = await findScriptByContentHash(user.id, contentHash);

      if (existing) {
        navigate("/practice", {
          replace,
          state: {
            session,
            // Previewed on step 1; and if it was saved before its language
            // was picked, the original language can still be read from it.
            uploadId: await stashUpload(file),
            replayScript: existing,
          },
        });
        return;
      }

      // Confirms an active subscription or trial for this upload. Every downstream parse call reuses this grant
      // read-only — see api/_entitlement.ts and the auth-subscriptions plan.
      let grant: string;
      try {
        const issued = await requestRehearsalGrant();
        if (issued === null) {
          toast("Start your free trial or subscribe to keep rehearsing.");
          navigate("/pricing");
          return;
        }
        grant = issued;
      } catch (err) {
        console.error("Couldn't start a rehearsal:", err);
        // A rate limit says when to come back; anything else, just retry.
        toast(
          err instanceof ApiError && err.reason === "rate_limited"
            ? err.message
            : "Couldn't start a new rehearsal. Please try again.",
        );
        return;
      }

      const uploadId = await stashUpload(file);
      navigate("/practice", {
        replace,
        state: { session, uploadId, rehearsalGrant: grant, contentHash },
      });
    },
    [user, navigate, toast],
  );
}
