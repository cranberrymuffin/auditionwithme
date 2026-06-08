import { useNavigate } from "react-router-dom";
import SiteNav from "../components/SiteNav";

export default function About() {
  const navigate = useNavigate();

  return (
    <div className="home-hero about-page">
      <SiteNav />

      <div className="home-text about-text">
        <h1 className="home-title about-title">ABOUT</h1>

        <div className="about-body">
          <p>
            AuditionWithMe is a practice tool for actors preparing for auditions.
          </p>
          <p>
            Upload your sides as a PDF. Claude reads and cleans the script —
            stripping annotations, crossed-out lines, and formatting noise —
            so you get a clear version of exactly what to perform.
          </p>
          <p>
            Choose the role you're auditioning for. The other characters' lines
            are read aloud by AI. When it's your turn, speak your lines — each
            word lights up as you say it so you can stay in the scene without
            breaking focus.
          </p>

          <h2 className="about-steps-title">HOW IT WORKS</h2>
          <ol className="about-steps">
            <li>Upload your PDF audition sides</li>
            <li>Choose the character you're reading for</li>
            <li>Other characters speak — your lines highlight word by word as you say them</li>
          </ol>
        </div>
      </div>

      <div className="home-hills">
        <svg
          className="home-hill home-hill--back"
          viewBox="0 0 1440 300"
          preserveAspectRatio="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M0,180 C200,80 480,240 720,140 C960,40 1200,160 1440,120 L1440,300 L0,300 Z"
            fill="rgba(232,117,106,0.55)"
          />
        </svg>
        <svg
          className="home-hill home-hill--front"
          viewBox="0 0 1440 300"
          preserveAspectRatio="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M0,240 C240,180 480,280 720,220 C960,160 1200,260 1440,220 L1440,300 L0,300 Z"
            fill="#E8756A"
          />
        </svg>

        <button className="home-upload-btn" onClick={() => navigate("/")}>
          START PRACTICING
        </button>
      </div>
    </div>
  );
}
