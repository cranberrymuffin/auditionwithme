import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import Seo from "../components/Seo";
import SiteNav from "../components/SiteNav";
import SiteFooter from "../components/SiteFooter";
import RehearsalMock from "../components/marketing/RehearsalMock";
import HowSteps from "../components/marketing/HowSteps";
import DataLedger from "../components/marketing/DataLedger";
import StartCta from "../components/marketing/StartCta";
import { useAuth } from "../contexts/AuthContext";
import { useEntitlement } from "../hooks/useEntitlement";
import { useToast } from "../lib/toast";
import { IS_BETA_TESTING } from "../lib/beta";
import { TRIAL_DAYS, hasPlanAccess } from "../lib/plan";
import { useStartRehearsal } from "../hooks/useStartRehearsal";

type HomeState = { intent?: string } | null;

// Rendered here, not hard-coded in index.html, so the offer it states is
// the one this build actually makes (beta, or trial then subscription).
const appSchema = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "AuditionWithMe",
  url: "https://www.auditionwithme.com/",
  applicationCategory: "EntertainmentApplication",
  operatingSystem: "Any (web-based)",
  description:
    "A browser-based rehearsal tool for actors that turns PDF scripts and audition sides into interactive scenes, reads other characters aloud, and keeps the actor's lines easy to follow.",
  // The subscription's price lives in Stripe, so outside the beta no price
  // is claimed here: the Pricing page shows the live one.
  ...(IS_BETA_TESTING
    ? {
        offers: {
          "@type": "Offer",
          price: "0",
          priceCurrency: "USD",
          description: "Free during beta",
        },
      }
    : {}),
};

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

  // One line under the button: what it costs, or what it takes.
  const offer = IS_BETA_TESTING
    ? "Now in beta · Free for testers"
    : `${TRIAL_DAYS}-day free trial · Cancel anytime`;
  const heroNote = !user
    ? offer
    : needsPlan
      ? trialAvailable
        ? `${TRIAL_DAYS} days free · Cancel anytime`
        : "Your saved scripts are waiting"
      : isSubscribed
        ? "PDF supported"
        : `PDF supported · ${offer}`;

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
      className="page home-page"
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
        title="AuditionWithMe | A rehearsal partner for actors"
        description={
          IS_BETA_TESTING
            ? "Free during beta."
            : `Try it free for ${TRIAL_DAYS} days.`
        }
        path="/"
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(appSchema) }}
      />
      <SiteNav />

      <section className="hero">
        <div className="hero-photo" aria-hidden="true" />
        <div className="wrap hero-inner">
          <div className="hero-copy" id="upload">
            <p className="slug">A rehearsal partner for actors</p>
            <h1 className="display">Rehearse your sides out loud.</h1>
            <p className="lead">
              Upload the PDF and choose your role. The app reads every other
              character, follows your lines as you speak them, and records
              the take.
            </p>

            <div className="hero-actions">
              {user ? (
                needsPlan ? (
                  <button
                    type="button"
                    className="btn-primary btn-lg"
                    onClick={() => navigate("/pricing")}
                  >
                    {trialAvailable
                      ? "Start your free trial"
                      : "Subscribe to keep rehearsing"}
                  </button>
                ) : (
                  <button
                    type="button"
                    className={`btn-primary btn-lg hero-upload ${dragging ? "is-dragging" : ""} ${
                      pulsing ? "is-pulsing" : ""
                    }`}
                    onClick={() => inputRef.current?.click()}
                  >
                    {dragging ? "Drop your script" : "Upload your script"}
                  </button>
                )
              ) : (
                <button
                  type="button"
                  className={`btn-primary btn-lg hero-upload ${dragging ? "is-dragging" : ""}`}
                  onClick={requestAuthForUpload}
                >
                  Start rehearsing free
                </button>
              )}
              {!user && (
                <Link className="btn-secondary btn-lg" to="/how-it-works">
                  See how it works
                </Link>
              )}
            </div>

            <p className="hero-note">{heroNote}</p>

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
        </div>
      </section>

      <section className="section" aria-labelledby="home-screen-title">
        <div className="wrap grid">
          <header className="section-head span-4">
            <p className="slug">The rehearsal screen</p>
            <h2 id="home-screen-title" className="title">
              Your scene, on one page.
            </h2>
            <p className="lead">
              Your lines are highlighted and follow along as you say them, so
              you can keep your eyes near the camera. When it’s someone
              else’s line, you hear it and the page waits for you.
            </p>
          </header>
          <div className="span-7 at-6">
            <RehearsalMock />
          </div>
        </div>
      </section>

      <section className="section" aria-labelledby="home-how-title">
        <div className="wrap">
          <header className="section-head section-head--wide">
            <p className="slug">How it works</p>
            <h2 id="home-how-title" className="title">
              From the PDF to a take you can send.
            </h2>
          </header>
          <HowSteps layout="columns" />
        </div>
      </section>

      <section className="section" aria-labelledby="home-data-title">
        <div className="wrap material-summary">
          <header className="section-head">
            <p className="slug">Your material</p>
            <h2 id="home-data-title" className="title">
              Your material. Your control.
            </h2>
            <p className="lead">
              Your work deserves discretion. We’ve designed the rehearsal
              experience with that in mind.
            </p>
          </header>
          <DataLedger />
        </div>
      </section>

      <section className="section closing" aria-labelledby="home-closing-title">
        <div className="wrap">
          <h2 id="home-closing-title" className="title">
            Bring the sides for your next audition.
          </h2>
          <StartCta />
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
