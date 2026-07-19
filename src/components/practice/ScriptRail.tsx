import { useEffect, useRef } from "react";
import type { Step } from "../../types";
import { normalizeSpeaker } from "../../lib/script";

export default function ScriptRail({ steps, currentIndex, selectedRole, onJump }: {
  steps: Step[];
  speakers: string[];
  currentIndex: number;
  selectedRole: string;
  onJump: (index: number) => void;
}) {
  const activeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [currentIndex]);

  return (
    <nav className="scene-rail" aria-label="Scene transcript">
      <header><strong>Scene transcript</strong><span>{steps.length} dialogue turns</span></header>
      <div>
        {steps.map((step, index) => {
          const speaker = normalizeSpeaker(step.speaker) || "Stage direction";
          const isUser = Boolean(selectedRole) && speaker === selectedRole;
          const active = index === currentIndex;
          const line = step.verbalLine || step.content[0]?.text || "";
          return (
            <button
              key={index}
              ref={active ? activeRef : undefined}
              aria-current={active ? "step" : undefined}
              aria-label={`Line ${index + 1}, ${speaker}${isUser ? ", your line" : ""}: ${line}`}
              onClick={() => onJump(index)}
              className={`${active ? "is-active" : ""} ${isUser ? "is-user" : ""} ${index < currentIndex ? "is-past" : ""}`}
            >
              <span className="scene-line-number">{String(index + 1).padStart(2, "0")}</span>
              <span className="scene-line-copy"><strong>{speaker}</strong><span>{line}</span></span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
