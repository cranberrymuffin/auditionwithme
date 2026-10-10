import { useEffect, useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { supabase } from "../lib/supabase";

/**
 * Whether the caller has a row in public.admins (RLS lets each user read
 * only their own). Display-only — decides whether to show the admin portal;
 * api/admin.ts re-checks on every request.
 */
export function useIsAdmin() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId) {
      setIsAdmin(false);
      setLoading(false);
      return;
    }

    let active = true;
    setLoading(true);

    supabase
      .from("admins")
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!active) return;
        setIsAdmin(!error && !!data);
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [userId]);

  return { isAdmin, loading };
}
