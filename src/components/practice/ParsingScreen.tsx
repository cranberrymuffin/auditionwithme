import { useEffect, useRef, useState } from "react";
import type { Step } from "../../types";
import DocumentPreview from "../DocumentPreview";
import ScriptName from "../ScriptName";
import SetupStep from "./SetupStep";
import ScriptLinesPreview from "./ScriptLinesPreview";
import { normalizeSpeaker, splitStepContent } from "../../lib/script";

export default function ParsingScreen({
  file,
  title,
  onRename,
  phase,
  onContinue,
  onReplace,
  steps,
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
  /** The parsed script, once read — shown under See script. */
  steps?: Step[];
}) {
  const replaceInputRef = useRef<HTMLInputElement | null>(null);
  const [scriptOpen, setScriptOpen] = useState(false);
  // See script's two views: what the app read, or the PDF itself.
  const [scriptView, setScriptView] = useState<"read" | "pdf">("read");
  // While the name is being edited, the actions below step aside.
  const [editingName, setEditingName] = useState(false);
  const [previewUrl, setPreviewUrl] = useState("");
  const done = phase === "done";
  const name = title ?? file?.name ?? "Your script";
  // On to step 2: the step's one primary action.
  const nextButton = onContinue && (
    <button type="button" className="setup-next" onClick={onContinue}>
      Choose your role <span aria-hidden="true">→</span>
    </button>
  );
  const parsedSteps = steps ?? [];
  const characterCount = new Set(
    parsedSteps.map((step) => normalizeSpeaker(step.speaker)).filter(Boolean),
  ).size;
  const lineCount = parsedSteps.filter((step) => step.verbalLine.trim()).length;
  const sceneCount = parsedSteps.filter(
    (step) => splitStepContent(step).sceneHeading,
  ).length;
  const hasPdf = Boolean(file && previewUrl);
  const view = hasPdf ? scriptView : "read";
  const replaceButton = (
    <button
      type="button"
      className="btn-secondary replace-script"
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
    <SetupStep
      step={1}
      scriptName={name}
      aria-live="polite"
      aria-busy={!done}
      aside={
        // While it's being read the PDF shows alongside; once read it
        // folds away under See script.
        !done && (
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
        )
      }
    >
      <h1 className={done && name.length > 26 ? "is-long-name" : undefined}>
        {done ? (
          <>
            Your rehearsal is set up for{" "}
            <span className="processing-script-name">
              <ScriptName
                name={name}
                onRename={onRename}
                onEditingChange={setEditingName}
              />
            </span>
          </>
        ) : (
          "Preparing your rehearsal"
        )}
      </h1>
      {done && onRename && !editingName && (
        <p className="processing-rename-hint">Tap the name to rename it.</p>
      )}
      <p className="processing-explanation">
        {done ? (
          parsedSteps.length > 0 && (
            <>
              We read {characterCount}{" "}
              {characterCount === 1 ? "character" : "characters"} and{" "}
              {lineCount} {lineCount === 1 ? "line" : "lines"}
              {sceneCount > 1 && <> across {sceneCount} scenes</>}. Check
              them under See script.
            </>
          )
        ) : (
          <>
            We’re identifying characters, dialogue, and scene directions in
            <strong> {name}</strong>. This usually takes under a minute.
          </>
        )}
      </p>
      {done && !editingName && (
        <>
          <div className="processing-actions">
            {(parsedSteps.length > 0 || hasPdf) && (
              <button
                type="button"
                className="btn-secondary"
                aria-expanded={scriptOpen}
                aria-controls="uploaded-script"
                onClick={() => setScriptOpen((open) => !open)}
              >
                {scriptOpen ? "Hide script" : "See script"}
              </button>
            )}
            {replaceButton}
            {nextButton}
          </div>
          {scriptOpen && (
            <div id="uploaded-script">
              {hasPdf && parsedSteps.length > 0 && (
                <div className="script-view-tabs" role="tablist" aria-label="Script view">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={view === "read"}
                    onClick={() => setScriptView("read")}
                  >
                    What we read
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={view === "pdf"}
                    onClick={() => setScriptView("pdf")}
                  >
                    Original PDF
                  </button>
                </div>
              )}
              {view === "read" && parsedSteps.length > 0 ? (
                <ScriptLinesPreview steps={parsedSteps} />
              ) : (
                file &&
                previewUrl && (
                  <DocumentPreview
                    src={previewUrl}
                    fileName={file.name}
                    fileSize={file.size}
                  />
                )
              )}
            </div>
          )}
        </>
      )}
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
          Keep this tab open while we process your file. Usually under a minute.
        </p>
      )}
    </SetupStep>
  );
}
