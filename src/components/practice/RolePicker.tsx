import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { Step } from "../../types";
import { normalizeSpeaker } from "../../lib/script";
import { Wordmark } from "../SiteNav";

export default function RolePicker({
  characters,
  steps,
  fileName,
  initialSelected,
  onChoose,
}: {
  characters: string[];
  steps: Step[];
  fileName: string;
  initialSelected: string | null;
  onChoose: (role: string) => void;
}) {
  const navigate = useNavigate();
  const [selected, setSelected] = useState<string | null>(initialSelected);
  const roleRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const linesFor = (name: string) =>
    steps.filter((step) => normalizeSpeaker(step.speaker) === name && step.verbalLine.trim());

  const displayName = (name: string) =>
    name.toLocaleLowerCase().replace(/(^|[\s'-])\p{L}/gu, (letter) => letter.toLocaleUpperCase());

  return (
    <main className="role-page">
      <header className="setup-header">
        <Link to="/" aria-label="Audition With Me home"><Wordmark /></Link>
        <div className="setup-progress" aria-label="Step 2 of 4: Choose role">
          <span>Step 2 of 4</span>
          <div aria-hidden="true"><i /><i className="is-active" /><i /><i /></div>
        </div>
        <button onClick={() => navigate("/")} className="setup-header-action">Replace script</button>
      </header>

      <section className="role-content">
        <div className="role-intro">
          <p>{fileName} · {characters.length} {characters.length === 1 ? "role" : "roles"} detected</p>
          <h1>Choose your role</h1>
          <span>Choose the character you’re rehearsing. We’ll read the other parts.</span>
        </div>

        <div className="role-grid" role="radiogroup" aria-label="Choose your role">
          {characters.map((character, index) => {
            const lines = linesFor(character);
            const excerpt = lines[0]?.verbalLine ?? "No spoken dialogue detected.";
            const isSelected = selected === character;
            return (
              <button
                key={character}
                type="button"
                role="radio"
                aria-checked={isSelected}
                ref={(element) => { roleRefs.current[index] = element; }}
                className={`role-option ${isSelected ? "is-selected" : ""}`}
                onClick={() => setSelected(character)}
                onKeyDown={(event) => {
                  if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)) return;
                  event.preventDefault();
                  const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
                  const next = (index + direction + characters.length) % characters.length;
                  setSelected(characters[next]);
                  roleRefs.current[next]?.focus();
                }}
              >
                <span className="role-radio" aria-hidden="true">{isSelected ? "✓" : ""}</span>
                <span className="role-option-copy">
                  <strong>{character}</strong>
                  <small>{lines.length} {lines.length === 1 ? "dialogue turn" : "dialogue turns"}</small>
                  <q>{excerpt.length > 120 ? `${excerpt.slice(0, 120)}…` : excerpt}</q>
                </span>
              </button>
            );
          })}
        </div>

        <div className="role-secondary">
          <span>Not rehearsing a role?</span>
          <button onClick={() => onChoose("")}>Listen to the full scene</button>
        </div>
        <div className="role-actions">
          <button className="role-continue" disabled={!selected} onClick={() => selected && onChoose(selected)}>
            {selected ? `Continue as ${displayName(selected)}` : "Choose a role to continue"}<span>→</span>
          </button>
        </div>
      </section>
    </main>
  );
}
