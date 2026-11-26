// A static picture of the rehearsal screen for the marketing pages, built
// from the same script-page classes (src/styles/script.css) the product
// uses. The scene and its characters are invented for the illustration.

const LINES = [
  { cue: "DEV", text: "You're late." },
  { cue: "MARA", yours: true, text: "" },
  { cue: "DEV", text: "You could have called." },
  { cue: "MARA", yours: true, text: "My phone was dead. I'm sorry." },
  { cue: "DEV", paren: "(not looking up)", text: "Sit down. Your coffee's cold." },
];

// The line being spoken, split where the app has heard up to.
const SAID = "I know. The train sat";
const CURRENT = "outside";
const TO_COME = "the station for forty minutes.";

export default function RehearsalMock() {
  return (
    <figure className="mock">
      <div
        className="mock-screen"
        role="img"
        aria-label="The rehearsal screen. A banner reads “Your line”. Below it, a short scene between Dev and Mara is laid out like a script page: Mara’s lines are highlighted, and the line being spoken is enlarged, with the words already said dimmed."
      >
        <div className="turn is-you">
          <strong>Your line</strong>
          <span>Listening. Go ahead.</span>
        </div>
        <div className="sides">
          <div className="sides-head">
            <span>diner_sides.pdf</span>
            <span className="mock-rec">
              <i aria-hidden="true" />
              Rec 00:12
            </span>
          </div>
          <div className="sides-body">
            <p className="sides-slug">Int. Diner - Night</p>
            {LINES.map((line, index) => {
              const active = index === 1;
              return (
                <div
                  key={index}
                  className={`sides-line ${line.yours ? "is-yours" : ""} ${active ? "is-active" : ""} ${index === 0 ? "is-past" : ""}`}
                >
                  <span className="sides-num">{String(index + 1).padStart(2, "0")}</span>
                  <div>
                    <p className="sides-cue">
                      {line.cue}
                      {line.yours && <span className="tag tag-accent">You</span>}
                    </p>
                    {line.paren && <p className="sides-paren">{line.paren}</p>}
                    <p className="sides-dialogue">
                      {active ? (
                        <span>
                          <span className="sides-word is-said">{SAID}</span>{" "}
                          <span className="sides-word is-current">{CURRENT}</span> {TO_COME}
                        </span>
                      ) : (
                        <span>{line.text}</span>
                      )}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <ul className="mock-controls">
          <li>Back</li>
          <li>Pause</li>
          <li>Replay</li>
          <li>Hide lines</li>
          <li>Next</li>
        </ul>
      </div>
      <figcaption>
        An illustration of the rehearsal screen. The scene and its characters
        are made up.
      </figcaption>
    </figure>
  );
}
