import { useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";

export default function Home() {
  const navigate = useNavigate();
  const [error, setError] = useState("");

  const handleFile = useCallback(
    (f: File) => {
      if (f.type !== "application/pdf") {
        setError("Please upload a PDF file.");
        return;
      }
      navigate("/viewer", { state: { file: f } });
    },
    [navigate]
  );

  return (
    <div className="home-hero">
      <div className="home-crescent" />

      <div className="home-text">
        <h1 className="home-title">
          AUDITION
          <br />
          WITH ME
        </h1>
        <p className="home-subtitle">
          Upload your audition script and practice with AI-powered line reading
        </p>
        {error && <p className="home-error">{error}</p>}
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

        <button
          className="home-upload-btn"
          onClick={() => document.getElementById("home-file-input")?.click()}
        >
          <svg
            className="home-upload-icon"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          UPLOAD PDF SCRIPT
        </button>

        <input
          id="home-file-input"
          type="file"
          accept="application/pdf"
          onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
          style={{ display: "none" }}
        />
      </div>
    </div>
  );
}
