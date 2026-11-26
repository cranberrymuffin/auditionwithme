import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";

// Each wizard step has its own URL, so Back/Forward, reloads and the
// address bar all agree on where the actor is (MDN, History API).
const STEP_PATHS = [
  "/practice",
  "/practice/role",
  "/practice/voices",
  "/practice/rehearse",
];
export const stepFromPath = (pathname: string) => {
  const index = STEP_PATHS.indexOf(pathname.replace(/\/+$/, ""));
  return index === -1 ? 0 : index;
};

/**
 * Keeps the practice wizard and browser history in step. Each step has its
 * own URL and history entry, so Back and Forward (and a phone's back swipe)
 * move through the wizard like pages. One effect keeps the two in step,
 * whichever moved: the app advancing (push a new entry), or history moving
 * (show that step — back directly, forward by re-making the choice that led
 * there). A reload restarts at the upload.
 */
export function useWizardHistory({
  wizardStep,
  stepCount,
  selectedRole,
  resumeStep,
  hasUploadStep,
  showEarlierStep,
  advanceStep,
}: {
  /** The step on screen, 0-based. */
  wizardStep: number;
  /** The script's line count: 0 until its steps have loaded. */
  stepCount: number;
  selectedRole: string | null;
  /** The step a reload landed on, from its URL. */
  resumeStep: number;
  /** "Practice as" jumps straight into Rehearsal, so it alone has no step 1
   * to go back to. */
  hasUploadStep: boolean;
  /** Shows step `target` (0-based), which is before the current one. */
  showEarlierStep: (target: number) => void;
  /** Re-makes the choice that leads past the current step; false if
   * there's none to re-make (still parsing, no role picked yet). */
  advanceStep: () => boolean;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const historyStep = stepFromPath(location.pathname);
  const locationStateRef = useRef(location.state);
  locationStateRef.current = location.state;
  const prevHistoryStepRef = useRef(historyStep);
  // Set just before the app navigates, so that move isn't taken for the
  // user's own Back/Forward.
  const selfNavRef = useRef(false);
  // The step history asked for, while the screen catches up to it.
  const targetStepRef = useRef<number | null>(null);
  const movedOnceRef = useRef(false);
  // Reloaded mid-flow: the saved script lands a render after mount, so leave
  // the URL alone until it has, rather than rewinding it to the upload.
  const resumingRef = useRef(resumeStep > 0);
  // A take in progress, reported by Rehearsal. Leaving through history
  // can't be cancelled (beforeunload doesn't fire for it), so it's
  // confirmed by hand below.
  const recordingActiveRef = useRef(false);
  // Set when the leave was already confirmed (Rehearsal's own Back button).
  const leaveConfirmedRef = useRef(false);

  // practiceIndex counts this flow's entries below the current one, so the
  // in-app Back only goes through history when there's a step to return to.
  const goToStepUrl = (step: number, replace: boolean) => {
    selfNavRef.current = true;
    const state = locationStateRef.current;
    const practiceIndex = (state?.practiceIndex ?? 0) + (replace ? 0 : 1);
    // Steps past the role picker remember it, for a reload to resume with.
    const chosenRole = step >= 2 ? selectedRole : undefined;
    navigate(STEP_PATHS[step], {
      replace,
      state: { ...state, practiceIndex, chosenRole },
    });
  };

  useEffect(() => {
    if (resumingRef.current) {
      if (stepCount === 0) return;
      resumingRef.current = false;
    }
    const historyMoved = prevHistoryStepRef.current !== historyStep;
    prevHistoryStepRef.current = historyStep;
    if (historyMoved) {
      if (selfNavRef.current) selfNavRef.current = false;
      else targetStepRef.current = historyStep;
    }

    const target = targetStepRef.current;
    if (target !== null) {
      if (target === wizardStep) {
        targetStepRef.current = null;
        return;
      }
      if (target < wizardStep) {
        const confirmed = leaveConfirmedRef.current;
        leaveConfirmedRef.current = false;
        if (
          wizardStep === 3 &&
          recordingActiveRef.current &&
          !confirmed &&
          !window.confirm(
            "You have unsaved changes. Are you sure you want to leave?",
          )
        ) {
          // Stay on the take: put its entry back.
          targetStepRef.current = null;
          goToStepUrl(3, false);
          return;
        }
        if (target === 0 && !hasUploadStep) {
          // Nothing of this flow before the role: keep going back, out.
          targetStepRef.current = null;
          navigate(-1);
          return;
        }
        showEarlierStep(target);
        return;
      }
      // Forward: one step at a time; this effect runs again as each lands.
      if (!advanceStep()) {
        targetStepRef.current = null;
        goToStepUrl(wizardStep, true);
      }
      return;
    }

    // The app moved the wizard. Without an upload step, the first step
    // reached takes over /practice's entry rather than stacking on it.
    if (wizardStep === historyStep) return;
    const first = !movedOnceRef.current;
    movedOnceRef.current = true;
    if (wizardStep > historyStep)
      goToStepUrl(wizardStep, first && !hasUploadStep);
    else goToStepUrl(wizardStep, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to step moves only
  }, [wizardStep, historyStep, stepCount]);

  /** The header's step bars: back to an earlier setup step (1-based).
   * Through history when the entries are there (so Back/Forward stay in
   * step: setup steps are always reached in order), else directly. */
  const goToStep = (step: number) => {
    const back = wizardStep - (step - 1);
    if (back <= 0) return;
    if ((location.state?.practiceIndex ?? 0) >= back) navigate(-back);
    else showEarlierStep(step - 1);
  };

  /** In-app Back: through history when there's an earlier step entry (so
   * browser Back/Forward stay in step), else `fallback`. */
  const stepBack = (fallback: () => void) => {
    if ((location.state?.practiceIndex ?? 0) > 0) {
      leaveConfirmedRef.current = true;
      navigate(-1);
    } else fallback();
  };

  /** Rehearsal reporting whether a take is recording or saving. */
  const setRecordingActive = (active: boolean) => {
    recordingActiveRef.current = active;
  };

  return { goToStep, stepBack, setRecordingActive };
}
