import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import Seo from "../components/Seo";
import SiteNav from "../components/SiteNav";
import { useAuth } from "../contexts/AuthContext";
import { useEntitlement } from "../hooks/useEntitlement";
import { useToast } from "../lib/toast";
import { IS_BETA_TESTING } from "../lib/beta";
import { TRIAL_DAYS, hasPlanAccess } from "../lib/plan";
import { useStartRehearsal } from "../hooks/useStartRehearsal";

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
  const startRehearsal = useStartRehearsal();
  const isSubscribed = hasPlanAccess(entitlement?.subscription_status);
  // No paywall during beta — rehearsals are unlimited (see src/lib/beta.ts
  // and api/_entitlement.ts). Otherwise a rehearsal needs a plan or trial.
  const needsPlan = !IS_BETA_TESTING && !!entitlement && !isSubscribed;
  // A past subscription means the trial's been used (api/billing.ts).
  const trialAvailable = !entitlement?.stripe_subscription_id;
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
      await startRehearsal(file);
    },
    [user, toast, requestAuthForUpload, startRehearsal],
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
      <Seo
        title="AuditionWithMe — A rehearsal partner for actors"
        description={
          IS_BETA_TESTING
            ? "Free during beta."
            : `Try it free for ${TRIAL_DAYS} days.`
        }
        path="/"
      />
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
              needsPlan ? (
                <button
                  type="button"
                  className="upload-cta"
                  onClick={() => navigate("/pricing")}
                >
                  <span className="upload-copy">
                    <strong>
                      {trialAvailable
                        ? "Start your free trial"
                        : "Subscribe to keep rehearsing"}
                    </strong>
                    <small>
                      {trialAvailable
                        ? `${TRIAL_DAYS} days free · Cancel anytime`
                        : "Your saved scripts are waiting"}
                    </small>
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
                  <small>
                    {IS_BETA_TESTING
                      ? "Upload a script to begin"
                      : `${TRIAL_DAYS}-day free trial`}
                  </small>
                </span>
              </button>
            )}
            {!user && (
              <a className="demo-cta" href="/how-it-works">
                <span className="demo-play" aria-hidden="true">
                  ▶
                </span>
                <span className="demo-cta-text">See how it works</span>
              </a>
            )}
          </div>

          {/* The trial CTA already says this when the paywall is showing. */}
          {!isSubscribed && !needsPlan && (
            <p className="hero-trust">
              {IS_BETA_TESTING
                ? "Now in beta · Free for testers"
                : `${TRIAL_DAYS}-day free trial · Cancel anytime`}
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
