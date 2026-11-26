import StageShell from "./StageShell";

/** A bilingual edition whose translation is all that's readable as text:
 * rehearse that, or have the original language read off the pages. */
export default function LanguageChoiceScreen({
  translationName,
  onRehearseTranslation,
  onReadOriginal,
}: {
  translationName: string | undefined;
  onRehearseTranslation: () => void;
  /** Absent when there's no PDF on hand to read the original from. */
  onReadOriginal?: () => void;
}) {
  return (
    <StageShell>
      <>
        <p className="slug">Bilingual edition</p>
        <h1 className="title">
          Which version do you want to rehearse?
        </h1>
        <p className="lead">
          This script prints its dialogue in two languages, and only the
          translation is readable as text. Rehearse the translation now, or
          have the original language read from the printed pages — that takes
          a few minutes.
          {!onReadOriginal && " Re-upload the PDF to have the original language read."}
        </p>
        <div className="stage-actions">
          <button
            type="button"
            className="btn-primary btn-lg"
            onClick={onRehearseTranslation}
          >
            Rehearse in {translationName ?? "the translation"}
          </button>
          {onReadOriginal && (
            <button
              type="button"
              className="btn-secondary btn-lg"
              onClick={onReadOriginal}
            >
              Read the original language (takes a few minutes)
            </button>
          )}
        </div>
      </>
    </StageShell>
  );
}
