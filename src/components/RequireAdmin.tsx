import type { ReactNode } from "react";
import { useIsAdmin } from "../hooks/useIsAdmin";
import NotFound from "../pages/NotFound";
import RequireAuth from "./RequireAuth";

/**
 * RequireAuth, plus a check for a public.admins row. Non-admins see the
 * ordinary 404 so the portal doesn't advertise itself. UX only — api/admin.ts
 * is what actually withholds the data.
 */
export default function RequireAdmin({ children }: { children: ReactNode }) {
  return (
    <RequireAuth>
      <AdminOnly>{children}</AdminOnly>
    </RequireAuth>
  );
}

function AdminOnly({ children }: { children: ReactNode }) {
  const { isAdmin, loading } = useIsAdmin();
  if (loading) return <div className="cinematic-page auth-page" aria-busy="true" />;
  if (!isAdmin) return <NotFound />;
  return <>{children}</>;
}
