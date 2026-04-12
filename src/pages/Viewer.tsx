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

  return (
    <>
      {isLoading && (
        <div className="loading-state">
          <div className="spinner" />
          <p>{loadingText}</p>
        </div>
      )}

      {error && (
        <div className="error-message">
          {error}
          <button className="back-btn" onClick={() => navigate("/")}>
            Try again
          </button>
        </div>
      )}

      {stepsError && <div className="error-message">{stepsError}</div>}

      {!isLoading && !error && steps.length === 0 && !stepsError && (
        <div className="steps-empty">No spoken lines detected in this script.</div>
      )}

      {currentStep && (
        <div className="step-viewer">
          <div className="step-viewer__counter">
            Step {currentStepIndex + 1} of {steps.length}
          </div>
          <div className="step-viewer__content">
            {currentStep.nonVerbalLines.map((line, i) => (
              <p key={i} className="step-viewer__nonverbal">
                {line}
              </p>
            ))}
            <p className="step-viewer__verbal">{currentStep.verbalLine}</p>
          </div>
          <div className="step-viewer__controls">
            <button
              className="step-btn"
              onClick={goPrev}
              disabled={currentStepIndex === 0}
            >
              ← Prev
            </button>
            <button
              className="step-btn"
              onClick={goNext}
              disabled={currentStepIndex >= steps.length - 1}
            >
              Next →
            </button>
          </div>
        </div>
      )}

      {!isLoading && (
        <button className="back-btn" onClick={() => navigate("/")}>
          ← Upload new script
        </button>
      )}
    </>
  );
}
