import { useSyncExternalStore } from "react";
import { getAudioLog, subscribeAudioLog } from "../lib/audioDiagnostics";

/** Live-subscribes to the audio diagnostic log for on-screen rendering. */
export function useAudioDiagnostics() {
  return useSyncExternalStore(subscribeAudioLog, getAudioLog, getAudioLog);
}
