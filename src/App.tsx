import { useState, useCallback } from "react";
import "./App.css";

function App() {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [script, setScript] = useState("");
  const [error, setError] = useState("");
  const [isDragging, setIsDragging] = useState(false);

  const handleFile = useCallback((f: File) => {
    if (f.type !== "application/pdf") {
      setError("Please upload a PDF file.");
      return;
    }
    setFile(f);
    setError("");
    setScript("");
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
    setLoading(true);
    setError("");
    setScript("");

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
      setScript(data.script);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(script);
  };

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
            onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
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
