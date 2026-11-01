// Fallback for when realtime word-for-word matching
// (src/hooks/useScribeTracking.ts) stalls: the actor paused (VAD committed a
// transcript segment) but speech-to-text never assembled enough of the exact/near-exact words to credit the
// line as spoken. Rather than leave the actor stuck on manual advance, ask
// whether the words STT DID catch still convey the line's meaning — tolerant
// of mishears and minor ad-libs, not a rubber stamp for silence or a
// different line entirely.
export const SEMANTIC_MATCH_SYSTEM_PROMPT = `You judge whether a speech-to-text transcript of an actor reading a script line actually conveys that line, despite likely transcription errors.

Say match:true if the transcript is consistent with the actor having spoken this line — allowing for misheard/garbled words, dropped small words, or minor ad-libbing that keeps the same meaning.
Say match:false if the transcript is empty, unrelated, a clearly different line, or too sparse/garbled to tell.

Return ONLY {"match": true} or {"match": false}.`;

/** The user turn: the line and what speech-to-text heard. */
export function semanticMatchPrompt(line: string, transcript: string): string {
  return `Script line: "${line}"\nTranscript: "${transcript}"`;
}
