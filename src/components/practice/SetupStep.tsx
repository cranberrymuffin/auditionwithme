import type { HTMLAttributes, ReactNode } from "react";
import SetupHeader from "./SetupHeader";
import StepHeader from "./StepHeader";

/**
 * The page every practice setup step sits in: the header with its step
 * bars, then one centered column opening with the step's row (step number
 * and script name). Each step brings only its own content.
 */
export default function SetupStep({
  step,
  title,
  scriptName,
  onGoToStep,
  aside,
  children,
  ...mainProps
}: {
  /** 1-based. */
  step: number;
  title: string;
  scriptName: string;
  /** Back to an earlier step (1-based), from the header's step bars. */
  onGoToStep?: (step: number) => void;
  /** Shown in a second column beside the step, e.g. step 1's PDF preview. */
  aside?: ReactNode;
  children: ReactNode;
} & HTMLAttributes<HTMLElement>) {
  return (
    <main className="processing-page" {...mainProps}>
      <SetupHeader step={step} onGoToStep={onGoToStep} />

      <section
        className={`processing-layout ${aside ? "" : "processing-layout--single"}`}
      >
        <div className="processing-status">
          <StepHeader step={step} title={title} scriptName={scriptName} />
          {children}
        </div>
        {aside}
      </section>
    </main>
  );
}
