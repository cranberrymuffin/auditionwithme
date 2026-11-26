import type { HTMLAttributes, ReactNode } from "react";
import SetupHeader from "./SetupHeader";
import StepHeader from "./StepHeader";

/**
 * The page every practice setup step sits in: the header with its numbered
 * steps, then the shared 12-column grid. The step's title and what it's
 * for sit in the left columns (`intro`); its decisions run down the right
 * (`children`). One column on phones. Each step brings only its own content.
 */
export default function SetupStep({
  step,
  scriptName,
  onGoToStep,
  intro,
  className,
  children,
  ...mainProps
}: {
  /** 1-based. */
  step: number;
  scriptName: string;
  /** Back to an earlier step (1-based), from the header's steps. */
  onGoToStep?: (step: number) => void;
  /** The step's title and lead-in, under the step row. */
  intro: ReactNode;
  children: ReactNode;
} & HTMLAttributes<HTMLElement>) {
  return (
    <main className={`setup-page ${className ?? ""}`} {...mainProps}>
      <SetupHeader step={step} onGoToStep={onGoToStep} />

      <div className="wrap grid setup-layout">
        <div className="setup-intro span-4">
          <StepHeader step={step} scriptName={scriptName} />
          {intro}
        </div>
        <div className="setup-body span-7 at-6">{children}</div>
      </div>
    </main>
  );
}
