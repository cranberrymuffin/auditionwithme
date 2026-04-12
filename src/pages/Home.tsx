import { useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";

export default function Home() {
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [isDragging, setIsDragging] = useState(false);

  const handleFile = useCallback((f: File) => {
    if (f.type !== "application/pdf") {
      setError("Please upload a PDF file.");
      return;
    }
    setFile(f);
    setError("");
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

  const handleAnalyze = () => {
    if (!file) return;
    navigate("/viewer", { state: { file } });
  };

  return (
    <>
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
        disabled={!file}
      >
        Generate Audition Script
      </button>
    </>
  );
}
