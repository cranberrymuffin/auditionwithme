import { useEffect, useRef, useState } from "react";
import type { ReplayScript, Step } from "../types";
import { normalizeSpeaker } from "../lib/script";
import { apiFetch } from "../lib/api";
import { DIRECTOR_VERSION } from "../lib/director";
import { leadingDirections } from "../lib/delivery";
import { updateScript } from "../lib/scriptStore";

/**
 * Per-line direction from the AI director (api/casting?action=direct-lines),
 * aligned by index with steps: performance markup on new parses, single-word
 * tags on rows saved before the markup upgrade. null until the pass finishes
 * (or fails silently). A replay seeds its saved tags through the setter.
 */
export function useDirectorTags({
  steps,
  canSave,
  scriptId,
  replayScript,
}: {
  steps: Step[];
  /** Signed in and the script's row exists, so the tags can be kept on it. */
  canSave: boolean;
  scriptId: string;
  replayScript: ReplayScript | null;
}) {
  const [deliveryTags, setDeliveryTags] = useState<(string | null)[] | null>(
    null,
  );

  // AI director pass: annotate each line with performance markup (inline v3
  // audio tags + pacing punctuation — how the scene partner should read it)
  // once steps load. Purely an enhancement — failures are silent and the
  // rehearsal reads lines unadorned.
  useEffect(() => {
    if (!steps.length || deliveryTags) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await apiFetch("/api/casting?action=direct-lines", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            lines: steps.map((step) => ({
              speaker: normalizeSpeaker(step.speaker),
              text: step.verbalLine,
              direction: leadingDirections(step.content) || undefined,
            })),
          }),
        });
        const data = (await response.json()) as {
          tags?: (string | null)[];
          error?: string;
        };
        if (!response.ok)
          throw new Error(data.error || "Line direction failed");
        if (!cancelled && Array.isArray(data.tags)) setDeliveryTags(data.tags);
      } catch (err) {
        console.error("Line direction error:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [steps, deliveryTags]);

  // Write freshly generated delivery tags back to the saved row so replays
  // skip the director call. Guarded so it fires once per session. Stamped
  // with DIRECTOR_VERSION so a later prompt change knows to re-direct them.
  const persistedTagsRef = useRef(false);
  useEffect(() => {
    if (!canSave || !deliveryTags || persistedTagsRef.current) return;
    persistedTagsRef.current = true;
    if (
      replayScript?.deliveryTags &&
      replayScript.directorVersion === DIRECTOR_VERSION
    ) {
      return; // current tags already stored on the row
    }
    void updateScript(scriptId, {
      deliveryTags,
      directorVersion: DIRECTOR_VERSION,
    }).catch((err) => console.error("Failed to save delivery tags:", err));
  }, [canSave, scriptId, deliveryTags, replayScript]);

  return [deliveryTags, setDeliveryTags] as const;
}
