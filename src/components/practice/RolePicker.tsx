import { useRef, useState } from "react";
import type { Step } from "../../types";
import { displayCharacterName, normalizeSpeaker } from "../../lib/script";
import StepHeader from "./StepHeader";
import SetupHeader from "./SetupHeader";

export default function RolePicker({
  characters,
  steps,
  fileName,
  initialSelected,
  onChoose,
  onGoToStep,
}: {
  characters: string[];
  steps: Step[];
  fileName: string;
  initialSelected: string | null;
  onChoose: (role: string) => void;
  /** Back to an earlier step (1-based), from the header's step bars. */
  onGoToStep: (step: number) => void;
}) {
  const [selected, setSelected] = useState<string | null>(initialSelected);
  const roleRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const linesFor = (name: string) =>
    steps.filter(
      (step) =>
        normalizeSpeaker(step.speaker) === name && step.verbalLine.trim(),
    );

  return (
    <main className="role-page">
      <SetupHeader step={2} onGoToStep={onGoToStep} />

      <section className="role-content">
        <StepHeader step={2} title="Cast yourself" scriptName={fileName} />

        <div className="role-intro">
          <p>
            {characters.length} {characters.length === 1 ? "role" : "roles"}{" "}
            detected
          </p>
          <h1>Choose your role</h1>
          <div className="role-secondary">
            <span>Not rehearsing a role?</span>
            <button onClick={() => onChoose("")}>
              Listen to the full scene
            </button>
          </div>
        </div>

        <div
          className="role-grid"
          role="radiogroup"
          aria-label="Choose your role"
        >
          {characters.map((character, index) => {
            const lines = linesFor(character);
            const excerpt =
              lines[0]?.verbalLine ?? "No spoken dialogue detected.";
            const isSelected = selected === character;
            return (
              <button
                key={character}
                type="button"
                role="radio"
                aria-checked={isSelected}
                ref={(element) => {
                  roleRefs.current[index] = element;
                }}
                className={`role-option ${isSelected ? "is-selected" : ""}`}
                onClick={() => setSelected(character)}
                onKeyDown={(event) => {
                  if (
                    ![
                      "ArrowRight",
                      "ArrowDown",
                      "ArrowLeft",
                      "ArrowUp",
                    ].includes(event.key)
                  )
                    return;
                  event.preventDefault();
                  const direction =
                    event.key === "ArrowRight" || event.key === "ArrowDown"
                      ? 1
                      : -1;
                  const next =
                    (index + direction + characters.length) % characters.length;
                  setSelected(characters[next]);
                  roleRefs.current[next]?.focus();
                }}
              >
                <span className="role-radio" aria-hidden="true">
                  {isSelected ? "✓" : ""}
                </span>
                <span className="role-option-copy">
                  <strong>{character}</strong>
                  <small>
                    {lines.length}{" "}
                    {lines.length === 1 ? "dialogue turn" : "dialogue turns"}
                  </small>
                  <q>
                    {excerpt.length > 120
                      ? `${excerpt.slice(0, 120)}…`
                      : excerpt}
                  </q>
                </span>
              </button>
            );
          })}
        </div>
        <div className="role-actions">
          <button
            className="role-continue"
            disabled={!selected}
            onClick={() => selected && onChoose(selected)}
          >
            {selected
              ? `Continue as ${displayCharacterName(selected)}`
              : "Choose a role to continue"}
            <span>→</span>
          </button>
        </div>
      </section>
    </main>
  );
}
