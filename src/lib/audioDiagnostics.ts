/**
 * Temporary, in-memory diagnostic log for chasing the mobile audio-context
 * reliability issues — a small ring buffer of timestamped events from the
 * TTS/recording/Scribe hooks, rendered live on-screen (see
 * useAudioDiagnostics) so real device behavior can be read straight off the
 * phone instead of guessed at from a desktop.
 */
export type AudioLogEntry = { time: number; tag: string; message: string };

const MAX_ENTRIES = 50;
let entries: AudioLogEntry[] = [];
const listeners = new Set<() => void>();

export function logAudioEvent(tag: string, message: string) {
  entries = [...entries, { time: Date.now(), tag, message }].slice(-MAX_ENTRIES);
  listeners.forEach((listener) => listener());
}

export function getAudioLog(): AudioLogEntry[] {
  return entries;
}

export function subscribeAudioLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
