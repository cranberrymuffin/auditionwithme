import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Wordmark } from "../SiteNav";
import DocumentPreview, { formatFileSize } from "../DocumentPreview";

export default function ParsingScreen({
  file,
  phase,
  onContinue,
}: {
  file: File;
  phase: "extracting" | "analyzing" | "done";
  /** Present once parsing is finished — advances to role/voice casting. */
  onContinue?: () => void;
}) {
  const navigate = useNavigate();
  const [previewUrl, setPreviewUrl] = useState("");
  const done = phase === "done";

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  return (
    <main className="processing-page" aria-live="polite" aria-busy={!done}>
      <header className="workflow-header">
        <Link to="/" aria-label="Audition With Me home">
          <Wordmark />
        </Link>
        <div className="workflow-file" title={file.name}>
          <span>{file.name}</span>
          <small>{formatFileSize(file.size)}</small>
        </div>
        <button onClick={() => navigate("/")} className="workflow-back">
          <span aria-hidden="true">←</span> Back to upload
        </button>
      </header>

      <section className="processing-layout">
        <div className="processing-status">
          <p className="processing-label">Rehearsal setup</p>
          <h1>{done ? "Your script is ready" : "Preparing your rehearsal"}</h1>
          <p className="processing-explanation">
            {done ? (
              <>
                We’ve read the characters, dialogue, and scene directions in
                <strong> {file.name}</strong>. Double-check the pages look
                right, then continue.
              </>
            ) : (
              <>
                We’re identifying characters, dialogue, and scene directions in
                <strong> {file.name}</strong>. This usually takes under a
                minute.
              </>
            )}
          </p>

          <ol className="processing-steps" aria-label="Processing progress">
            <li className="is-complete">
              <span className="processing-step-icon" aria-label="Complete">
                ✓
              </span>
              <div>
                <strong>Upload complete</strong>
                <small>Your document arrived safely.</small>
              </div>
            </li>
            <li
              className={done ? "is-complete" : "is-current"}
              aria-current={done ? undefined : "step"}
            >
              <span
                className="processing-step-icon"
                aria-label={done ? "Complete" : "In progress"}
              >
                {done ? "✓" : <i />}
              </span>
              <div>
                <strong>
                  {done
                    ? "Script analyzed"
                    : phase === "extracting"
                      ? "Extracting script text"
                      : "Analyzing your script"}
                </strong>
                <small>
                  {done
                    ? "Dialogue, characters, and directions identified."
                    : phase === "extracting"
                      ? "Reading the text layer directly from your PDF."
                      : "Identifying dialogue, characters, and directions."}
                </small>
              </div>
            </li>
            <li
              className={done ? "is-current" : "is-pending"}
              aria-current={done ? "step" : undefined}
            >
              <span
                className="processing-step-icon"
                aria-label={done ? "Ready" : "Pending"}
              >
                {done ? <i /> : "○"}
              </span>
              <div>
                <strong>Building your rehearsal</strong>
                <small>Voice casting comes next.</small>
              </div>
            </li>
          </ol>

          {done && onContinue ? (
            <button
              type="button"
              className="processing-continue"
              onClick={onContinue}
            >
              Continue to casting <span aria-hidden="true">→</span>
            </button>
          ) : (
            <p className="processing-note">
              Keep this tab open while we process your file. Usually under a
              minute.
            </p>
          )}
        </div>

        {previewUrl && (
          <DocumentPreview
            src={previewUrl}
            fileName={file.name}
            fileSize={file.size}
          />
        )}
      </section>
    </main>
  );
}
