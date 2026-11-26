import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { Step } from "../types";
import { normalizeSpeaker } from "../lib/script";
import { apiFetch } from "../lib/api";
import { useToast } from "../lib/toast";

/**
 * Auto-cast: asks for a fitting voice for each character when the steps
 * first load, merging the answer under any picks the actor has made
 * meanwhile. Returns whether casting has settled — answered, failed, or
 * not needed — after which anyone still uncast gets a default voice.
 */
export function useAutoCasting({
  steps,
  languageCode,
  savedVoices,
  setCharacterVoices,
}: {
  steps: Step[];
  languageCode: string;
  /** A replay's saved casting, speaker → voice id. */
  savedVoices: Record<string, string> | null | undefined;
  setCharacterVoices: Dispatch<SetStateAction<Record<string, string>>>;
}): boolean {
  const toast = useToast();
  const [castingSettled, setCastingSettled] = useState(false);

  useEffect(() => {
    if (!steps.length) return;
    let cancelled = false;
    const uniqueSpeakers = [
      ...new Set(steps.map((s) => normalizeSpeaker(s.speaker)).filter(Boolean)),
    ];
    // Replays with a complete saved casting keep their scene partners —
    // don't re-run auto-casting and risk recasting voices.
    if (savedVoices && uniqueSpeakers.every((name) => savedVoices[name])) {
      setCastingSettled(true);
      return;
    }
    setCastingSettled(false);
    const characterList = uniqueSpeakers.map((name) => ({
      name,
      sampleLines: steps
        .filter((s) => normalizeSpeaker(s.speaker) === name)
        .slice(0, 3)
        .map((s) => s.verbalLine)
        .filter(Boolean),
    }));
    if (!characterList.length) return;

    void (async () => {
      try {
        const response = await apiFetch("/api/casting?action=voices", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ characters: characterList, languageCode }),
        });
        const data = (await response.json()) as {
          voices?: Record<string, string>;
          error?: string;
        };
        if (!response.ok)
          throw new Error(data.error || "Voice matching failed");
        // Merge under any manual picks the user already made while this was in flight.
        if (!cancelled && data.voices) {
          setCharacterVoices((previous) => ({ ...data.voices, ...previous }));
        }
      } catch (err) {
        console.error("Character voice matching error:", err);
        if (!cancelled)
          toast("Automatic voice casting didn't work, so we picked voices for you. Change them under Customize voices.");
      } finally {
        if (!cancelled) setCastingSettled(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [steps, languageCode, savedVoices, setCharacterVoices, toast]);

  return castingSettled;
}
