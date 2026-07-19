import type { ReactNode } from "react";
import SiteNav from "../SiteNav";
import Hills from "../Hills";
import { useNavigate } from "react-router-dom";
import BackButton from "../BackButton";

/** Full-viewport sky-backed shell shared by the practice wizard stages. */
export default function StageShell({
  children,
  cta,
  onBack,
}: {
  children: ReactNode;
  /** Optional call-to-action rendered on the hills */
  cta?: ReactNode;
  onBack?: () => void;
}) {
  const navigate = useNavigate();
  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-sky">
      <SiteNav />
      <BackButton onClick={onBack ?? (() => navigate("/"))} />
      <div className="relative z-10 mx-auto w-full max-w-3xl flex-1 px-6 pb-[clamp(180px,36vh,320px)] pt-8 sm:px-10">
        {children}
      </div>
      <Hills>{cta}</Hills>
    </div>
  );
}
