import { useCallback, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import SiteNav from "../components/SiteNav";

const MAX_PDF_BYTES = 14 * 1024 * 1024;

export default function Home() {
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const handleFile = useCallback((file: File) => {
    if (file.type !== "application/pdf") {
      setError("That file isn't a PDF — try another one.");
      return;
    }
    if (file.size > MAX_PDF_BYTES) {
      setError("That PDF is over 14 MB. Compress it and try again.");
      return;
    }
    setError("");
    navigate("/practice", { state: { file } });
  }, [navigate]);

  return (
    <main
      className="cinematic-page home-page"
      onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
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
            <span className="hero-title-italic">
              before you walk in.
            </span>
          </h1>
          <p className="hero-description">
            Upload your script. Hear every other character read aloud.
            Rehearse your scenes anytime.
          </p>

          <div className="hero-actions">
            <button
              type="button"
              className={`upload-cta ${dragging ? "is-dragging" : ""}`}
              onClick={() => inputRef.current?.click()}
            >
              <span className="upload-icon" aria-hidden="true">
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14.5v3.75A1.75 1.75 0 006.75 20h10.5A1.75 1.75 0 0019 18.25V14.5" />
                </svg>
              </span>
              <span className="upload-copy">
                <strong>{dragging ? "Drop your script" : "Upload your script"}</strong>
                <small>PDF supported · Start rehearsing free</small>
              </span>
            </button>
            <a className="demo-cta" href="/about#how-it-works">
              <span className="demo-play" aria-hidden="true">▶</span>
              See how it works
            </a>
          </div>

          {error && <p className="upload-error" role="alert">{error}</p>}
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
