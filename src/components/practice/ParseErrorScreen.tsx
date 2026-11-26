import { useRef } from "react";
import StageShell from "./StageShell";

/** Step 1 couldn't produce a script to rehearse: the parse failed (Try
 * again), the PDF holds no dialogue (`notScript`), or it's too large for
 * the service (`tooLarge`) — retrying those two with the same file won't
 * help, so they only offer a different one. */
export default function ParseErrorScreen({
  notScript,
  tooLarge = false,
  detail,
  onRetry,
  onUploadAnother,
}: {
  notScript: boolean;
  tooLarge?: boolean;
  detail: string;
  onRetry?: () => void;
  /** A PDF picked here, to start over with in place of this one. */
  onUploadAnother: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const canRetry = !notScript && !tooLarge && Boolean(onRetry);
  return (
    <StageShell>
      <>
        <p className="slug">
          {notScript ? "No dialogue found" : tooLarge ? "File too large" : "Something went wrong"}
        </p>
        <h1 className="title">
          {notScript
            ? "This doesn’t look like a script."
            : tooLarge
              ? "That PDF is too big for us to read."
              : "We couldn’t read that script."}
        </h1>
        <p className="lead" role="alert">{detail}</p>
        {(notScript || tooLarge) && (
          <ul className="stage-tips">
            <li>Upload just the pages with your scene, not the whole script.</li>
            <li>Scanned or photographed pages are fine, as long as the text is legible.</li>
            <li>PDFs only, up to 50 MB. Fewer pages read faster.</li>
          </ul>
        )}
        <div className="stage-actions">
          {canRetry && (
            <button
              type="button"
              className="btn-primary btn-lg"
              onClick={onRetry}
            >
              Try again
            </button>
          )}
          <button
            type="button"
            className={canRetry ? "btn-secondary btn-lg" : "btn-primary btn-lg"}
            onClick={() => inputRef.current?.click()}
          >
            Upload a different script
          </button>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={(event) => {
            const next = event.target.files?.[0];
            // Cleared so picking the same file again still fires.
            event.target.value = "";
            if (next) onUploadAnother(next);
          }}
        />
      </>
    </StageShell>
  );
}
