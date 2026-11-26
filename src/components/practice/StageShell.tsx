import type { ReactNode } from "react";
import SiteNav from "../SiteNav";
import { useNavigate } from "react-router-dom";
import BackButton from "../BackButton";

/** The page behind step 1's dead ends (a script that couldn't be read, a
 * bilingual edition to choose from): the site header, a way back, and one
 * left-aligned column on the shared grid edge. */
export default function StageShell({
  children,
  onBack,
}: {
  children: ReactNode;
  onBack?: () => void;
}) {
  const navigate = useNavigate();
  return (
    <main className="page stage-page">
      <SiteNav />
      <BackButton onClick={onBack ?? (() => navigate("/"))} />
      <section className="wrap stage">{children}</section>
    </main>
  );
}
