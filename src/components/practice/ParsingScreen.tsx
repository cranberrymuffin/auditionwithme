import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Wordmark } from "../SiteNav";
import DocumentPreview, { formatFileSize } from "../DocumentPreview";

export default function ParsingScreen({
  file,
  title,
  phase,
  onContinue,
  onReplace,
}: {
  /** The uploaded PDF; null for a script saved earlier and reopened from
   * My Auditions, which has no PDF on hand — it shows without a preview. */
  file: File | null;
  /** Shown in place of the file name when there's no file. */
  title?: string;
  phase: "extracting" | "analyzing" | "done";
  /** Present once parsing is finished — advances to role/voice casting. */
  onContinue?: () => void;
  /** A new PDF picked with Replace script, to parse in place of this one. */
  onReplace: (file: File) => void;
}) {
  const replaceInputRef = useRef<HTMLInputElement | null>(null);
  const [scriptOpen, setScriptOpen] = useState(false);
  const [previewUrl, setPreviewUrl] = useState("");
  const done = phase === "done";
  const name = file?.name ?? title ?? "Your script";
  // To step 2, at the right end of the row while the script is folded away.
  const nextButton = onContinue && (
    <button type="button" className="script-accordion-toggle script-accordion-next" onClick={onContinue}>
      Cast scene
    </button>
  );
  const replaceButton = (
    <button type="button" className="replace-script" onClick={() => replaceInputRef.current?.click()}>
      Replace script
    </button>
  );

  useEffect(() => {
    if (!file) return;
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
        <div className="workflow-file" title={name}>
          <span>{name}</span>
          {file && <small>{formatFileSize(file.size)}</small>}
        </div>
      </header>

      <section className={`processing-layout ${done ? "processing-layout--single" : ""}`}>
        <div className="processing-status">
          <p className="processing-label">Step 1 of 4 · Rehearsal setup</p>
          <h1>{done ? "Your script is ready" : "Preparing your rehearsal"}</h1>
          <p className="processing-explanation">
            {done ? (
              <>
                We’ve read the characters, dialogue, and scene directions in
                <strong> {name}</strong>. Pick who you’re playing next.
              </>
            ) : (
              <>
                We’re identifying characters, dialogue, and scene directions in
                <strong> {name}</strong>. This usually takes under a
                minute.
              </>
            )}
          </p>
          {done && file && previewUrl ? (
            <div className="script-accordion">
              <div className="script-accordion-actions">
                <button
                  type="button"
                  className="script-accordion-toggle"
                  aria-expanded={scriptOpen}
                  aria-controls="uploaded-script"
                  onClick={() => setScriptOpen((open) => !open)}
                >
                  {scriptOpen ? "Hide script" : "See script"}
                </button>
                {scriptOpen ? (
                  <>
                    <span className="script-accordion-dot" aria-hidden="true">·</span>
                    {replaceButton}
                    {onContinue && (
                      <>
                        <span className="script-accordion-dot" aria-hidden="true">·</span>
                        <button type="button" className="script-accordion-toggle" onClick={onContinue}>
                          Cast scene
                        </button>
                      </>
                    )}
                  </>
                ) : (
                  nextButton
                )}
              </div>
              {scriptOpen && (
                <div id="uploaded-script">
                  <DocumentPreview src={previewUrl} fileName={file.name} fileSize={file.size} />
                </div>
              )}
            </div>
          ) : done ? (
            // Reopened from My Auditions: no PDF on hand to show.
            <div className="script-accordion-actions">
              {replaceButton}
              {nextButton}
            </div>
          ) : null}
          <input
            ref={replaceInputRef}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={(event) => {
              const next = event.target.files?.[0];
              // Cleared so picking the same file again still fires.
              event.target.value = "";
              if (next) onReplace(next);
            }}
          />

          {/* Progress only while the script is being read; once it's
              parsed there's nothing left to wait on. */}
          {!done && (
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
          )}

          {!done && (
            <p className="processing-note">
              Keep this tab open while we process your file. Usually under a
              minute.
            </p>
          )}
        </div>

        {/* While it's being read the PDF shows alongside; once read it
            folds away under See script. */}
        {!done && (
          <div className="processing-preview">
            {file && previewUrl && (
              <DocumentPreview
                src={previewUrl}
                fileName={file.name}
                fileSize={file.size}
              />
            )}
            {replaceButton}
          </div>
        )}
      </section>
    </main>
  );
}
