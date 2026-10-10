import { useRef, useState } from "react";
import type { Step } from "../../types";
import { dialogueTurnsLabel, spokenLines } from "../../lib/script";
import SetupStep from "./SetupStep";
import SetupActions from "./SetupActions";
import CastGrid, { CastCard } from "./CastGrid";

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

  return (
    <SetupStep
      step={2}
      title="Cast yourself"
      scriptName={fileName}
      onGoToStep={onGoToStep}
    >
      <div className="role-intro">
        <h1>Choose your role</h1>
      </div>
      <CastGrid
        items={characters}
        label="Choose your role"
        role="radiogroup"
        renderCard={(character, index) => {
          const lines = spokenLines(steps, character);
          const isSelected = selected === character;
          return (
            <CastCard
              key={character}
              role="radio"
              aria-checked={isSelected}
              active={isSelected}
              mark={isSelected ? "✓" : ""}
              name={character}
              detail={dialogueTurnsLabel(lines.length)}
              quote={lines[0]?.verbalLine ?? "No spoken dialogue detected."}
              buttonRef={(element) => {
                roleRefs.current[index] = element;
              }}
              onClick={() => setSelected(isSelected ? null : character)}
              onKeyDown={(event) => {
                if (
                  !["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(
                    event.key,
                  )
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
            />
          );
        }}
      />
      <div className="role-intro">
        <div className="role-secondary">
          <span>Not rehearsing a role?</span>
          <button onClick={() => onChoose("")}>Skip</button>
        </div>
      </div>
      <SetupActions
        onBack={() => onGoToStep(1)}
        nextLabel="Direct your scene"
        nextDisabled={!selected}
        onNext={() => selected && onChoose(selected)}
      />
    </SetupStep>
  );
}
