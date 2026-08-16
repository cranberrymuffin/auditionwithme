import { useNavigate } from "react-router-dom";
import SiteNav from "../components/SiteNav";
import { useAuth } from "../contexts/AuthContext";

const steps = [
  ["01", "Upload", "Add your PDF sides."],
  ["02", "Choose your role", "Select the character you’re rehearsing."],
  ["03", "Rehearse", "Hear every other role and stay focused on your scene."],
];

export default function About() {
  const navigate = useNavigate();
  const { user } = useAuth();

  return (
    <main className="cinematic-page about-page-clean">
      <div className="cinematic-backdrop" aria-hidden="true" />
      <SiteNav />

      <section className="about-product-layout">
        <div className="about-product-intro">
          <p>Built for rehearsal</p>
          <h1>A better way to get off book</h1>
          <div>
            Upload your sides, choose your role, and rehearse with every other
            character read aloud while your lines follow along on screen.
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
                  <small>Three rehearsals for free</small>
                </>
              )}
            </span>
            <span aria-hidden="true">→</span>
          </button>
        </div>

        <section
          className="about-process-panel"
          id="how-it-works"
          aria-labelledby="how-it-works-title"
        >
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
