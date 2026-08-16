import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import SiteNav from "../components/SiteNav";
import { useAuth } from "../contexts/AuthContext";
import { useEntitlement } from "../hooks/useEntitlement";
import { useToast } from "../lib/toast";
import { apiFetch } from "../lib/api";
import { supabase } from "../lib/supabase";
import { hashFile } from "../lib/scriptHash";
import type { SavedScript } from "../types";

// Scanned PDFs are rendered to page images client-side (never uploaded whole),
// so the cap only guards browser memory.
const MAX_PDF_BYTES = 50 * 1024 * 1024;

type HomeState = { intent?: string } | null;

export default function Home() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const [dragging, setDragging] = useState(false);
  const [pulsing, setPulsing] = useState(false);
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

  const sessionsStatus = entitlement
    ? `${freeSessionsRemaining} free sessions left`
    : null;
  // The hero trust line right below the CTA carries the session count, so
  // the button hint stays minimal to avoid saying it twice.
  const uploadHint = "PDF supported";

  // A visitor who clicked the upload CTA while signed out lands back here
  // after authenticating — draw their eye straight to the upload flow.
  useEffect(() => {
    if (user && (location.state as HomeState)?.intent === "upload") {
      navigate(location.pathname, { replace: true, state: null });
      document
        .getElementById("upload")
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
      setPulsing(true);
      const timer = setTimeout(() => setPulsing(false), 2800);
      return () => clearTimeout(timer);
    }
  }, [user, location.state, location.pathname, navigate]);

  const requestAuthForUpload = useCallback(() => {
    navigate("/signup", {
      state: { from: { pathname: "/" }, intent: "upload" },
    });
  }, [navigate]);

  const handleFile = useCallback(
    async (file: File) => {
      if (!user) {
        toast("Create a free account to start rehearsing.");
        requestAuthForUpload();
        return;
      }
      if (file.type !== "application/pdf") {
        toast("That file isn't a PDF — try another one.");
        return;
      }
      if (file.size > MAX_PDF_BYTES) {
        toast("That PDF is over 50 MB. Compress it and try again.");
        return;
      }

      // Re-uploading a script already parsed for this account should reuse
      // the stored steps instead of paying for another AI parse (and,
      // matching the My Account "practice again" path, shouldn't burn a
      // free session/rehearsal grant for it either).
      const contentHash = await hashFile(file);
      const { data: existing } = await supabase
        .from("scripts")
        .select(
          "id,title,language_code,language_name,characters,steps,content_hash,character_voices,delivery_tags",
        )
        .eq("user_id", user.id)
        .eq("content_hash", contentHash)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existing) {
        const saved = existing as SavedScript;
        navigate("/practice", {
          state: {
            replayScript: {
              id: saved.id,
              title: saved.title,
              steps: saved.steps,
              characters: saved.characters,
              languageCode: saved.language_code,
              languageName: saved.language_name,
              characterVoices: saved.character_voices,
              deliveryTags: saved.delivery_tags,
            },
          },
        });
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
    [user, navigate, toast, requestAuthForUpload],
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
          <p className="hero-kicker">A rehearsal partner for actors</p>
          <h1 className="hero-title">
            <span className="hero-title-roman">Own the room</span>
            <span className="hero-title-italic">before you walk in.</span>
          </h1>
          <p className="hero-description">
            Upload your script, choose your character, and rehearse every scene
            with responsive scene partners.
          </p>

          <div className="hero-actions">
            {user ? (
              isOutOfFreeSessions ? (
                <button
                  type="button"
                  className="upload-cta"
                  onClick={() => navigate("/pricing")}
                >
                  <span className="upload-copy">
                    <strong>Subscribe to keep rehearsing</strong>
                    <small>{sessionsStatus}</small>
                  </span>
                </button>
              ) : (
                <button
                  type="button"
                  className={`upload-cta ${dragging ? "is-dragging" : ""} ${
                    pulsing ? "is-pulsing" : ""
                  }`}
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
              )
            ) : (
              <button
                type="button"
                className={`upload-cta ${dragging ? "is-dragging" : ""}`}
                onClick={requestAuthForUpload}
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
                  <strong>Start rehearsing free</strong>
                  <small>Upload a script to begin</small>
                </span>
              </button>
            )}
            {!user && (
              <a className="demo-cta" href="/about#how-it-works">
                <span className="demo-play" aria-hidden="true">
                  ▶
                </span>
                <span className="demo-cta-text">See how it works</span>
              </a>
            )}
          </div>

          {!isSubscribed && (
            <p className="hero-trust">
              {sessionsStatus
                ? `${sessionsStatus}`
                : "3 free sessions · No credit card required"}
            </p>
          )}

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
