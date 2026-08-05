import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";

/**
 * Client-side route guard (UX only — the real boundary is the JWT check on
 * every /api/* route). Renders nothing until the session check resolves so a
 * logged-in user never flashes the login page on a hard refresh.
 */
export default function RequireAuth({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth();
  const location = useLocation();

  if (loading) return <div className="cinematic-page auth-page" aria-busy="true" />;
  if (!session) return <Navigate to="/login" state={{ from: location }} replace />;

  return <>{children}</>;
}
