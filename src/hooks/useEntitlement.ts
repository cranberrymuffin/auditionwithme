import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { supabase } from "../lib/supabase";
import type { Entitlement } from "../types";

/**
 * Reads the caller's own entitlements row (RLS already scopes this to the
 * caller; the user_id filter is explicit anyway). Display-only — enforcement
 * lives server-side. Call refresh() to re-read, e.g. after returning from
 * Stripe Checkout, where the webhook may land after the redirect.
 */
export function useEntitlement() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [entitlement, setEntitlement] = useState<Entitlement | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadCount, setReloadCount] = useState(0);

  const refresh = useCallback(() => setReloadCount((count) => count + 1), []);

  useEffect(() => {
    if (!userId) {
      setEntitlement(null);
      setLoading(false);
      return;
    }

    let active = true;
    setLoading(true);

    supabase
      .from("entitlements")
      .select("*")
      .eq("user_id", userId)
      .single()
      .then(({ data, error }) => {
        if (!active) return;
        // No row yet (the signup trigger may not have fired) is not an error
        // worth surfacing — the server lazily upserts one on first use.
        setEntitlement(error ? null : (data as Entitlement));
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [userId, reloadCount]);

  return { entitlement, loading, refresh };
}
