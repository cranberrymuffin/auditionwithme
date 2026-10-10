import { useEffect, useRef, useState } from "react";
import DocumentPreview from "../DocumentPreview";
import ScriptName from "../ScriptName";
import StepHeader from "./StepHeader";
import SetupHeader from "./SetupHeader";

export default function ParsingScreen({
  file,
  title,
  onRename,
  phase,
  onContinue,
  onReplace,
}: {
  /** The uploaded PDF; null for a script saved earlier and reopened from
   * My Auditions, which has no PDF on hand — it shows without a preview. */
  file: File | null;
  /** The script's name: its saved title, else the file name. */
  title?: string;
  /** Renames the script; makes the name in the heading editable. */
  onRename?: (next: string) => void;
  phase: "extracting" | "analyzing" | "done";
  /** Present once parsing is finished — advances to role/voice casting. */
  onContinue?: () => void;
  /** A new PDF picked with Replace script, to parse in place of this one. */
  onReplace: (file: File) => void;
}) {
  const replaceInputRef = useRef<HTMLInputElement | null>(null);
  const [scriptOpen, setScriptOpen] = useState(false);
  // While the name is being edited, the actions below step aside.
  const [editingName, setEditingName] = useState(false);
  const [previewUrl, setPreviewUrl] = useState("");
  const done = phase === "done";
  const name = title ?? file?.name ?? "Your script";
  // To step 2, at the right end of the row while the script is folded away.
  const nextButton = onContinue && (
    <button
      type="button"
      className="script-accordion-toggle script-accordion-next"
      onClick={onContinue}
    >
      Cast scene
    </button>
  );
  const replaceButton = (
    <button
      type="button"
      className="replace-script"
      onClick={() => replaceInputRef.current?.click()}
    >
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
      <SetupHeader step={1} />

      <section
        className={`processing-layout ${done ? "processing-layout--single" : ""}`}
      >
        <div className="processing-status">
          <StepHeader step={1} title="Rehearsal setup" scriptName={name} />
          <h1>
            {done ? (
              <>
                Your rehearsal is set up for{" "}
                <span className="processing-script-name">
                  <ScriptName name={name} onRename={onRename} onEditingChange={setEditingName} />
                </span>
              </>
            ) : (
              "Preparing your rehearsal"
            )}
          </h1>
          <p className="processing-explanation">
            {done ? (
              <>
                {scriptOpen && (
                  <>
                    We’ve read the characters, dialogue, and scene directions.
                  </>
                )}
              </>
            ) : (
              <>
                We’re identifying characters, dialogue, and scene directions in
                <strong> {name}</strong>. This usually takes under a minute.
              </>
            )}
          </p>
          {editingName ? null : done && file && previewUrl ? (
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
                    <span className="script-accordion-dot" aria-hidden="true">
                      ·
                    </span>
                    {replaceButton}
                    {onContinue && (
                      <>
                        <span
                          className="script-accordion-dot"
                          aria-hidden="true"
                        >
                          ·
                        </span>
                        <button
                          type="button"
                          className="script-accordion-toggle"
                          onClick={onContinue}
                        >
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
                  <DocumentPreview
                    src={previewUrl}
                    fileName={file.name}
                    fileSize={file.size}
                  />
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
