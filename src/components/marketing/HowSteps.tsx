import type { ReactNode } from "react";

// The four steps of a rehearsal, each shown with the thing the actor sees
// at that step, drawn from the script-page classes. Illustrations only:
// file names, characters and counts are invented.

type Step = {
  title: string;
  summary: string;
  detail: string;
  artefact: ReactNode;
};

const STEPS: Step[] = [
  {
    title: "Upload your sides",
    summary: "Add the PDF you were sent. The app reads it into characters and lines.",
    detail:
      "Scanned pages work too. Before you go on, you can compare what was read against the original PDF.",
    artefact: (
      <div className="sides step-art">
        <div className="sides-head">
          <span>diner_sides.pdf</span>
          <span>Page 1 of 3</span>
        </div>
        <div className="sides-body">
          <p className="sides-slug">Int. Diner - Night</p>
          <p className="sides-action">
            Dev has been waiting a while. Mara comes in from the rain.
          </p>
        </div>
      </div>
    ),
  },
  {
    title: "Choose your role",
    summary: "Pick the character you're reading. Their lines become yours to say.",
    detail:
      "Every other character in the scene is read aloud to you, so you can play it against someone.",
    artefact: (
      <ul className="step-art step-cast">
        <li className="is-picked">
          <span className="sides-cue">Mara</span>
          <span className="tag tag-accent">You</span>
        </li>
        <li>
          <span className="sides-cue">Dev</span>
          <span className="meta">Read to you</span>
        </li>
      </ul>
    ),
  },
  {
    title: "Hear your scene partners",
    summary: "Each other character gets a voice. Listen, and change it if it's wrong for the part.",
    detail:
      "Adjust a voice's volume, emotion and pace. You can also record a line yourself to show a scene partner how it should be said.",
    artefact: (
      <div className="step-art step-voice">
        <p className="sides-cue">Dev</p>
        <dl>
          <div>
            <dt>Volume</dt>
            <dd style={{ ["--at" as string]: "70%" }} />
          </div>
          <div>
            <dt>Emotion</dt>
            <dd style={{ ["--at" as string]: "45%" }} />
          </div>
          <div>
            <dt>Pace</dt>
            <dd style={{ ["--at" as string]: "55%" }} />
          </div>
        </dl>
      </div>
    ),
  },
  {
    title: "Rehearse and record",
    summary: "Your partners say their lines and wait for yours. Your camera records the take.",
    detail:
      "Your lines track on screen as you speak, so you can look at the camera. Run the scene without recording first if you like, then download the take from My Auditions and send it in.",
    artefact: (
      <dl className="slate step-art step-slate">
        <div>
          <dt>Scene</dt>
          <dd>1</dd>
        </div>
        <div>
          <dt>Take</dt>
          <dd>2</dd>
        </div>
        <div>
          <dt>Time</dt>
          <dd>00:42</dd>
        </div>
      </dl>
    ),
  },
];

/** `columns`: the short version, four across (home). `rows`: each step with
 * its fuller explanation beside its illustration (How it works). */
export default function HowSteps({ layout }: { layout: "columns" | "rows" }) {
  return (
    <ol className={`how-steps how-steps--${layout}`}>
      {STEPS.map((step, index) => (
        <li key={step.title}>
          <div className="how-step-copy">
            <span className="how-step-num" aria-hidden="true">
              {String(index + 1).padStart(2, "0")}
            </span>
            <h3>{step.title}</h3>
            <p>{step.summary}</p>
            {layout === "rows" && <p>{step.detail}</p>}
          </div>
          <div className="how-step-art" aria-hidden="true">
            {step.artefact}
          </div>
        </li>
      ))}
    </ol>
  );
}
