import { useNavigate } from "react-router-dom";
import Seo from "../components/Seo";
import SiteNav from "../components/SiteNav";
import { useAuth } from "../contexts/AuthContext";
import { IS_BETA_TESTING } from "../lib/beta";

const steps = [
  ["01", "Upload", "Add your PDF sides."],
  ["02", "Choose your role", "Select the character you’re rehearsing."],
  [
    "03",
    "Rehearse & record",
    "Hear every other role while your camera records a self-tape of your take.",
  ],
  [
    "04",
    "Download & submit",
    "Save your self-tape from My Account and send it in for the audition.",
  ],
];

export default function About() {
  const navigate = useNavigate();
  const { user } = useAuth();

  return (
    <main className="cinematic-page about-page-clean">
      <Seo
        title="How It Works"
        description="Upload your sides, choose your role, and rehearse with every other character read aloud while your lines follow along on screen. Record a self-tape as you go and download it to submit for your audition."
        path="/how-it-works"
      />
      <div className="cinematic-backdrop" aria-hidden="true" />
      <SiteNav />

      <section className="about-product-layout">
        <div className="about-product-intro">
          <p>Built for rehearsal</p>
          <h1>A better way to get off book</h1>
          <div>
            Upload your sides, choose your role, and rehearse with every other
            character read aloud while your lines follow along on screen.
            Record a self-tape as you go, then download it to submit for
            your audition.
          </div>
          <button
            type="button"
            className="upload-cta about-cta-button"
            onClick={() => navigate(user ? "/" : "/signup")}
          >
            <span className="upload-copy">
              {user ? (
                <>
                  <strong>Upload your script</strong>
                  <small>Rehearse your next scene</small>
                </>
              ) : (
                <>
                  <strong>Sign up</strong>
                  <small>{IS_BETA_TESTING ? "Beta test now" : "Three rehearsals for free"}</small>
                </>
              )}
            </span>
            <span aria-hidden="true">→</span>
          </button>
        </div>

        <section className="about-process-panel" aria-labelledby="how-it-works-title">
          <header>
            <h2 id="how-it-works-title">How it works</h2>
          </header>
          <ol>
            {steps.map(([number, title, detail]) => (
              <li key={number}>
                <span>{number}</span>
                <div>
                  <strong>{title}</strong>
                  <p>{detail}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </section>
    </main>
  );
}
