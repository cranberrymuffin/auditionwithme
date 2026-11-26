// "Your takes stay on this device", shown before the first recording
// (RehearsalSetup) and with a saved take (MyAccount) until it's dismissed
// once: said before work is invested, without nagging on every take.
const KEY = "awm:deviceStorageNoticeDismissed";

export function isStorageNoticeDismissed(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    // No storage to remember a dismissal in: show it rather than hide it.
    return false;
  }
}

export function rememberStorageNoticeDismissed() {
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    // Private mode: it shows again next time.
  }
}
