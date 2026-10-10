import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../lib/toast";
import { apiFetch } from "../lib/api";
import { findScriptByContentHash, toReplayScript } from "../lib/scriptStore";
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
            replayScript: toReplayScript(existing),
          },
        });
        return;
      }

      // Consumes exactly one free session (or confirms an active subscription)
      // for this upload. Every downstream parse call reuses this grant
      // read-only — see api/_entitlement.ts and the auth-subscriptions plan.
      let grant: string;
      try {
        const res = await apiFetch("/api/start-rehearsal", { method: "POST" });
        if (res.status === 402) {
          toast("You're out of free sessions — subscribe to keep rehearsing.");
          navigate("/pricing");
          return;
        }
        if (!res.ok) throw new Error("start-rehearsal failed");
        const data = (await res.json()) as { grant?: string };
        if (!data.grant) throw new Error("No grant returned");
        grant = data.grant;
      } catch {
        toast("Couldn't start a new rehearsal. Please try again.");
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
