import { useCallback, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import SiteNav from "../components/SiteNav";
import { useAuth } from "../contexts/AuthContext";
import { useEntitlement } from "../hooks/useEntitlement";
import { useToast } from "../lib/toast";
import { apiFetch } from "../lib/api";

// Scanned PDFs are rendered to page images client-side (never uploaded whole),
// so the cap only guards browser memory.
const MAX_PDF_BYTES = 50 * 1024 * 1024;

export default function Home() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { entitlement } = useEntitlement();
  const freeSessionsRemaining = entitlement
    ? Math.max(
        entitlement.free_sessions_limit - entitlement.free_sessions_used,
        0,
      )
    : 0;
  const isSubscribed = entitlement?.subscription_status === "active";
  const isOutOfFreeSessions =
    !!entitlement && !isSubscribed && freeSessionsRemaining === 0;

  const uploadHint = isSubscribed
    ? "PDF supported"
    : "PDF supported · Start rehearsing free";

  const handleFile = useCallback(
    async (file: File) => {
      if (file.type !== "application/pdf") {
        toast("That file isn't a PDF — try another one.");
        return;
      }
      if (file.size > MAX_PDF_BYTES) {
        toast("That PDF is over 50 MB. Compress it and try again.");
        return;
      }

      // Consumes exactly one free session (or confirms an active subscription)
      // for this upload. Every downstream parse call reuses this grant
      // read-only — see api/_entitlement.ts and the auth-subscriptions plan.
      let grant: string;
      try {
        const res = await apiFetch("/api/start-rehearsal", { method: "POST" });
        if (res.status === 402) {
          toast("You're out of free sessions — subscribe to keep rehearsing.");
          navigate("/pricing");
          return;
        }
        if (!res.ok) throw new Error("start-rehearsal failed");
        const data = (await res.json()) as { grant?: string };
        if (!data.grant) throw new Error("No grant returned");
        grant = data.grant;
      } catch {
        toast("Couldn't start a new rehearsal. Please try again.");
        return;
      }

      navigate("/practice", { state: { file, rehearsalGrant: grant } });
    },
    [navigate, toast],
  );

  return (
    <main
      className="cinematic-page home-page"
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        const file = event.dataTransfer.files?.[0];
        if (file) handleFile(file);
      }}
    >
      <div className="cinematic-backdrop" aria-hidden="true" />
      <SiteNav />

      <section className="hero-editorial">
        <div className="hero-copy" id="upload">
          <h1 className="hero-title">
            <span className="hero-title-roman">Own the room</span>
            <span className="hero-title-italic">before you walk in.</span>
          </h1>
          <p className="hero-description">
            Upload your script. Hear every other character read aloud. Rehearse
            your scenes anytime.
          </p>

          <div className="hero-actions">
            {user &&
              (isOutOfFreeSessions ? (
                <button
                  type="button"
                  className="upload-cta"
                  onClick={() => navigate("/pricing")}
                >
                  <span className="upload-copy">
                    <strong>Subscribe to keep rehearsing</strong>
                    <small>Free sessions exhausted</small>
                  </span>
                </button>
              ) : (
                <button
                  type="button"
                  className={`upload-cta ${dragging ? "is-dragging" : ""}`}
                  onClick={() => inputRef.current?.click()}
                >
                  <span className="upload-icon" aria-hidden="true">
                    <svg
                      width="19"
                      height="19"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                    >
                      <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14.5v3.75A1.75 1.75 0 006.75 20h10.5A1.75 1.75 0 0019 18.25V14.5" />
                    </svg>
                  </span>
                  <span className="upload-copy">
                    <strong>
                      {dragging ? "Drop your script" : "Upload your script"}
                    </strong>
                    <small>{uploadHint}</small>
                  </span>
                </button>
              ))}
            <a className="demo-cta" href="/about#how-it-works">
              <span className="demo-play" aria-hidden="true">
                ▶
              </span>
              <span className="demo-cta-text">See how it works</span>
            </a>
          </div>

          <input
            ref={inputRef}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) handleFile(file);
            }}
          />
        </div>
      </section>
    </main>
  );
}
