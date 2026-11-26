import { createContext, useContext } from "react";
import type { Session, User } from "@supabase/supabase-js";

export type AuthState = {
  user: User | null;
  session: Session | null;
  /** True until the initial getSession() call resolves — guards route redirects. */
  loading: boolean;
};

/** Provided by AuthProvider (AuthProvider.tsx); read it with useAuth(). */
export const AuthContext = createContext<AuthState | null>(null);

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside <AuthProvider>");
  return value;
}
