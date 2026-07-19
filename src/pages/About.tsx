import { useNavigate } from "react-router-dom";
import SiteNav from "../components/SiteNav";

const steps = [
  ["01", "Upload", "Add your PDF sides."],
  ["02", "Choose your role", "Select the character you’re rehearsing."],
  ["03", "Rehearse", "Hear every other role and stay focused on your scene."],
];

export default function About() {
  const navigate = useNavigate();

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
          <button onClick={() => navigate("/")}>Upload your sides <span>→</span></button>
          <small>PDF files supported. Start with three free sessions.</small>
        </div>

        <section className="about-process-panel" id="how-it-works" aria-labelledby="how-it-works-title">
          <header><p>Product workflow</p><h2 id="how-it-works-title">How it works</h2></header>
          <ol>
            {steps.map(([number, title, detail]) => (
              <li key={number}>
                <span>{number}</span>
                <div><strong>{title}</strong><p>{detail}</p></div>
              </li>
            ))}
          </ol>
        </section>
      </section>
    </main>
  );
}
