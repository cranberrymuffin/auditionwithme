import { useState, useCallback, useEffect, useRef } from "react";
import "./App.css";
import type { Step } from "./types";

const hasSpeechSynthesis =
  typeof window !== "undefined" && "speechSynthesis" in window;

function App() {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [script, setScript] = useState("");
  const [error, setError] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [stepsLoading, setStepsLoading] = useState(false);
  const [stepsError, setStepsError] = useState("");
  const stepsAbortRef = useRef<AbortController | null>(null);

  const handleFile = useCallback((f: File) => {
    if (f.type !== "application/pdf") {
      setError("Please upload a PDF file.");
      return;
    }
    stepsAbortRef.current?.abort();
    setFile(f);
    setError("");
    setScript("");
    setSteps([]);
    setCurrentStepIndex(0);
    setStepsError("");
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const f = e.dataTransfer.files[0];
      if (f) handleFile(f);
    },
    [handleFile]
  );

  const handleAnalyze = async () => {
    if (!file) return;

    stepsAbortRef.current?.abort();
    setLoading(true);
    setError("");
    setScript("");
    setSteps([]);
    setCurrentStepIndex(0);
    setStepsError("");

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
      setScript(data.script);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
      return;
    } finally {
      setLoading(false);
    }

    // Analyze succeeded — now parse steps (non-fatal, separate loading state)
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
      setStepsError(
        "Step-through view unavailable — your script is still ready below."
      );
    } finally {
      setStepsLoading(false);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(script);
  };

  // TTS: auto-play verbal line on step change, cancel on cleanup
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

  return (
    <div className="app">
      <header className="app-header">
        <h1>AuditionWithMe</h1>
        <p>Upload your sides and get a clean, analysis-ready script</p>
      </header>

      <main className="app-main">
        <div
          className={`upload-zone${isDragging ? " dragging" : ""}${file ? " has-file" : ""}`}
          onDrop={handleDrop}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onClick={() => document.getElementById("file-input")?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) =>
            e.key === "Enter" && document.getElementById("file-input")?.click()
          }
        >
          <input
            id="file-input"
            type="file"
            accept="application/pdf"
            onChange={(e) =>
              e.target.files?.[0] && handleFile(e.target.files[0])
            }
            style={{ display: "none" }}
          />
          {file ? (
            <div className="file-info">
              <span className="file-icon">📄</span>
              <div>
                <p className="file-name">{file.name}</p>
                <p className="file-size">{(file.size / 1024).toFixed(1)} KB</p>
              </div>
            </div>
          ) : (
            <div className="upload-prompt">
              <div className="upload-icon">↑</div>
              <p className="upload-text">Drop your PDF here or click to browse</p>
              <p className="upload-hint">
                Handles annotations, strikethroughs, and handwritten notes
              </p>
            </div>
          )}
        </div>

        {error && <div className="error-message">{error}</div>}

        <button
          className="analyze-btn"
          onClick={handleAnalyze}
          disabled={!file || loading}
        >
          {loading ? "Analyzing…" : "Generate Audition Script"}
        </button>

        {loading && (
          <div className="loading-state">
            <div className="spinner" />
            <p>Claude is reading your script…</p>
          </div>
        )}

        {stepsLoading && (
          <div className="loading-state">
            <div className="spinner" />
            <p>Preparing step-through view…</p>
          </div>
        )}

        {stepsError && (
          <div className="error-message">{stepsError}</div>
        )}

        {!stepsLoading && script && steps.length === 0 && !stepsError && (
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

        {script && (
          <div className="script-output">
            <div className="script-output-header">
              <h2>Audition Script</h2>
              <button className="copy-btn" onClick={handleCopy}>
                Copy to clipboard
              </button>
            </div>
            <pre className="script-content">{script}</pre>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
