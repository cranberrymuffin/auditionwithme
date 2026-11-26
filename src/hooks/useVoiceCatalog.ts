import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Voice } from "../lib/script";
import { apiFetch } from "../lib/api";
import { useToast } from "../lib/toast";

/** The full voice catalog, so the actor can override auto-assigned voices.
 * Empty until it loads (or if it can't). */
export function useVoiceCatalog(): Voice[] {
  const navigate = useNavigate();
  const toast = useToast();
  const [voices, setVoices] = useState<Voice[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await apiFetch("/api/eleven-account");
        if (response.status === 401) {
          if (!cancelled) navigate("/login", { replace: true });
          return;
        }
        const data = (await response.json()) as {
          voices?: Voice[];
          error?: string;
        };
        if (!response.ok)
          throw new Error(data.error || "Voice list fetch failed");
        if (!cancelled && Array.isArray(data.voices)) setVoices(data.voices);
      } catch (err) {
        console.error("Voice list fetch error:", err);
        if (!cancelled)
          toast(
            "The voice catalog couldn't be loaded. Voice options may be limited.",
          );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [toast, navigate]);

  return voices;
}
