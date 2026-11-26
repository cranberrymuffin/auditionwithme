import type { Step } from "../../types";
import { normalizeSpeaker, splitStepContent } from "../../lib/script";

/**
 * The script as the app read it — scene headings, directions, who says
 * what — laid out as a script page (script.css), so an actor can catch a
 * misread before rehearsing rather than in the middle of a take.
 */
export default function ScriptLinesPreview({ steps }: { steps: Step[] }) {
  return (
    <div className="sides script-read">
      <ol className="sides-body" aria-label="Script as read">
        {steps.map((step, index) => {
          const { sceneHeading, leadIn, speech } = splitStepContent(step);
          const speaker = normalizeSpeaker(step.speaker);
          return (
            <li key={index}>
              {sceneHeading && <p className="sides-slug">{sceneHeading}</p>}
              {leadIn.map((text, i) => (
                <p key={i} className="sides-action">
                  {text}
                </p>
              ))}
              {speaker && <p className="sides-cue">{speaker}</p>}
              <p className="sides-dialogue">
                {speech.map((item, i) =>
                  item.kind === "nonverbal" ? (
                    <em key={i} className="sides-paren">{item.text} </em>
                  ) : (
                    <span key={i}>{item.text} </span>
                  ),
                )}
              </p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
