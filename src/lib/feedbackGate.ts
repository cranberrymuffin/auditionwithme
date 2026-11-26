// Tiny pub/sub between the takes that owe feedback and FeedbackGate.tsx,
// without plumbing state through App.tsx. See src/lib/beta.ts for the flag
// that turns the whole gate on/off.
type Listener = () => void;
const owedListeners = new Set<Listener>();
const requestListeners = new Set<Listener>();

/** A take was saved, rated or skipped: whoever tracks "is feedback owed"
 * should look again. */
export function notifyFeedbackOwedChanged() {
  owedListeners.forEach((listener) => listener());
}

export function onFeedbackOwedChanged(listener: Listener) {
  owedListeners.add(listener);
  return () => {
    owedListeners.delete(listener);
  };
}

/** Brings the gate back after "Not now": the actor tried to record another
 * take while one still owes feedback. */
export function requestFeedbackGate() {
  requestListeners.forEach((listener) => listener());
}

export function onFeedbackGateRequested(listener: Listener) {
  requestListeners.add(listener);
  return () => {
    requestListeners.delete(listener);
  };
}
