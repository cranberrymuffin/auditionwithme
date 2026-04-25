import { useState, useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { Step } from "../types";

const hasSpeechSynthesis =
  typeof window !== "undefined" && "speechSynthesis" in window;

export default function Viewer() {
  const location = useLocation();
  const navigate = useNavigate();
  const file: File | null = location.state?.file ?? null;

  const [loading, setLoading] = useState(false);
  const [stepsLoading, setStepsLoading] = useState(false);
  const [error, setError] = useState("");
  const [stepsError, setStepsError] = useState("");
  const [steps, setSteps] = useState<Step[]>([]);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const stepsAbortRef = useRef<AbortController | null>(null);
  const didRun = useRef(false);

  useEffect(() => {
    if (!file) {
      navigate("/", { replace: true });
      return;
    }
    if (didRun.current) return;
    didRun.current = true;

    const run = async () => {
      setLoading(true);
      let scriptText = "";

      try {
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const result = reader.result as string;
            resolve(result.split(",")[1]);
          };
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });

        const res = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pdfData: base64 }),
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Analysis failed");
        scriptText = data.script;
      } catch (err) {
        setError(err instanceof Error ? err.message : "An error occurred");
        setLoading(false);
        return;
      }

      setLoading(false);

      const controller = new AbortController();
      stepsAbortRef.current = controller;
      setStepsLoading(true);

      try {
        const stepsRes = await fetch("/api/parse-steps", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scriptText }),
          signal: controller.signal,
        });
        if (!stepsRes.ok) throw new Error("Failed to parse steps");
        const parsed = await stepsRes.json();
        setSteps(parsed.steps ?? []);
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") return;
        console.error("parse-steps error:", e);
        setStepsError("Step-through view unavailable.");
      } finally {
        setStepsLoading(false);
      }
    };

    run();

    return () => stepsAbortRef.current?.abort();
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  // TTS: auto-play verbal line on step change
  useEffect(() => {
    if (!hasSpeechSynthesis || !steps.length) return;
    const step = steps[currentStepIndex];
    if (!step?.verbalLine?.trim()) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(step.verbalLine));
    return () => window.speechSynthesis.cancel();
  }, [currentStepIndex, steps]);

  const goNext = () => {
    if (hasSpeechSynthesis) window.speechSynthesis.cancel();
    setCurrentStepIndex((i) => Math.min(i + 1, steps.length - 1));
  };

  const goPrev = () => {
    if (hasSpeechSynthesis) window.speechSynthesis.cancel();
    setCurrentStepIndex((i) => Math.max(i - 1, 0));
  };

  const currentStep = steps[currentStepIndex];
  const isLoading = loading || stepsLoading;
  const loadingText = loading
    ? "Claude is reading your script…"
    : "Preparing step-through view…";

  const hills = (
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
    </div>
  );

  return (
    <>
      {isLoading && (
        <div className="home-hero viewer-loading">
          <div className="home-crescent" />
          <div className="home-text">
            <h1 className="home-title">
              {loading ? <>READING<br />YOUR SCRIPT</> : <>ALMOST<br />READY</>}
            </h1>
            <p className="home-subtitle">{loadingText}</p>
          </div>
          {hills}
        </div>
      )}

      <div className="viewer-page">
        <header className="viewer-header">
          <button className="viewer-header__brand" onClick={() => navigate("/")}>
            AuditionWithMe
          </button>
        </header>

        <div className="viewer-body">
          {error && <p className="viewer-error">{error}</p>}
          {stepsError && <p className="viewer-error">{stepsError}</p>}

          {!isLoading && !error && steps.length === 0 && !stepsError && (
            <p className="viewer-empty">No spoken lines detected in this script.</p>
          )}

          {currentStep && (
            <div className="viewer-step">
              <p className="viewer-step__counter">
                Step {currentStepIndex + 1} of {steps.length}
              </p>
              <div className="viewer-step__content">
                {currentStep.nonVerbalLines.map((line, i) => (
                  <p key={i} className="viewer-step__nonverbal">{line}</p>
                ))}
                <p className="viewer-step__verbal">{currentStep.verbalLine}</p>
              </div>
              <div className="viewer-step__controls">
                <button
                  className="viewer-btn"
                  onClick={goPrev}
                  disabled={currentStepIndex === 0}
                >
                  ← Prev
                </button>
                <button
                  className="viewer-btn"
                  onClick={goNext}
                  disabled={currentStepIndex >= steps.length - 1}
                >
                  Next →
                </button>
              </div>
            </div>
          )}
        </div>

        {hills}
      </div>
    </>
  );
}
