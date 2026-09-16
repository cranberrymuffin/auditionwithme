import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";

type AuthState = {
  user: User | null;
  session: Session | null;
  /** True until the initial getSession() call resolves — guards route redirects. */
  loading: boolean;
};

const AuthContext = createContext<AuthState | null>(null);

/** Holds the Supabase session for the whole app. Wrap once, read via useAuth(). */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return;
      if (data.session) {
        // getSession() only reads the locally cached token — verify it's
        // still valid server-side (it won't be if the account was deleted or
        // the signing key that issued it was revoked) before trusting it.
        const { error } = await supabase.auth.getUser();
        if (error) {
          await supabase.auth.signOut();
          return;
        }
      }
      if (!active) return;
      setSession(data.session);
      setLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setLoading(false);
    });

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  const value = useMemo<AuthState>(
    () => ({ user: session?.user ?? null, session, loading }),
    [session, loading]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside <AuthProvider>");
  return value;
}
