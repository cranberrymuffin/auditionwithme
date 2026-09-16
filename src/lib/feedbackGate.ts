// Tiny pub/sub so any component can tell FeedbackGate.tsx "an audition just
// closed, re-check for pending feedback" without plumbing state through
// App.tsx. MyAccount.tsx's closeExpanded() is the main caller — see
// src/lib/beta.ts for the flag that turns the whole gate on/off.
type Listener = () => void;
const listeners = new Set<Listener>();

export function notifyAuditionClosed() {
  listeners.forEach((listener) => listener());
}

export function onAuditionClosed(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
