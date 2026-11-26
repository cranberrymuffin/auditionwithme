import { useEffect, useState } from "react";
import { IS_BETA_TESTING } from "../lib/beta";
import { onFeedbackOwedChanged } from "../lib/feedbackGate";
import { getPendingFeedbackTape } from "../lib/selfTapeStore";

/**
 * Beta: whether a saved take is still waiting for its rating (or a skip).
 * FeedbackGate can be put off with "Not now", so this is what actually
 * holds back the next recorded take.
 */
export function useFeedbackOwed(userId: string | undefined): boolean {
  const [owed, setOwed] = useState(false);
  useEffect(() => {
    if (!IS_BETA_TESTING || !userId) return;
    let active = true;
    const check = () => {
      getPendingFeedbackTape(userId)
        .then((tape) => { if (active) setOwed(tape !== null); })
        // Can't read the store: don't hold a take back over a nudge.
        .catch(() => { if (active) setOwed(false); });
    };
    check();
    const unsubscribe = onFeedbackOwedChanged(check);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [userId]);
  return owed;
}
