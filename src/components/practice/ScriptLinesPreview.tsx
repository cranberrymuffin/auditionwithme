import type { Step } from "../../types";
import { normalizeSpeaker, splitStepContent } from "../../lib/script";

/**
 * The script as the app read it — scene headings, directions, who says
 * what — laid out like a page, so an actor can catch a misread before
 * rehearsing rather than in the middle of a take.
 */
export default function ScriptLinesPreview({ steps }: { steps: Step[] }) {
  return (
    <ol className="script-lines-preview" aria-label="Script as read">
      {steps.map((step, index) => {
        const { sceneHeading, leadIn, speech } = splitStepContent(step);
        const speaker = normalizeSpeaker(step.speaker);
        return (
          <li key={index}>
            {sceneHeading && <p className="script-lines-scene">{sceneHeading}</p>}
            {leadIn.map((text, i) => (
              <p key={i} className="script-lines-action">
                {text}
              </p>
            ))}
            {speaker && <p className="script-lines-speaker">{speaker}</p>}
            <p className="script-lines-speech">
              {speech.map((item, i) =>
                item.kind === "nonverbal" ? (
                  <em key={i}>{item.text} </em>
                ) : (
                  <span key={i}>{item.text} </span>
                ),
              )}
            </p>
          </li>
        );
      })}
    </ol>
  );
}
