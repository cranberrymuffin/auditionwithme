import { useEffect, useState } from "react";
import { countMatchedWords } from "../lib/script";
import { apiFetch } from "../lib/api";

const SCRIBE_WS_BASE = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
const SAMPLE_RATE = 16000;

function floatTo16BitPcmBase64(input: Float32Array): string {
  const buf = new ArrayBuffer(input.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Live word tracking via ElevenLabs Scribe v2 Realtime.
 *
 * While `active`, streams mic audio over a token-authenticated WebSocket and
 * matches incremental transcripts against `line` with the monotonic
 * `countMatchedWords` matcher (the count never regresses). Returns the matched
 * word count plus whether tracking is actually live (mic + socket up), so the
 * caller can fall back to manual advance when it isn't.
 */
export function useScribeTracking(active: boolean, line: string, languageCode = "en") {
  const [matchedWordCount, setMatchedWordCount] = useState(0);
  const [listening, setListening] = useState(false);

  useEffect(() => {
    setMatchedWordCount(0);
    if (!active || !line.trim()) return;

    const scriptWords = line.split(/\s+/).filter(Boolean);
    const state = { committed: "", closed: false };
    let ws: WebSocket | null = null;
    let audioContext: AudioContext | null = null;
    let stream: MediaStream | null = null;
    let processor: ScriptProcessorNode | null = null;

    const cleanup = () => {
      state.closed = true;
      processor?.disconnect();
      stream?.getTracks().forEach((t) => t.stop());
      audioContext?.close().catch(() => {});
      if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
      setListening(false);
    };

    const start = async () => {
      try {
        const [tokenRes, mic] = await Promise.all([
          apiFetch("/api/scribe-token", { method: "POST" }),
          navigator.mediaDevices.getUserMedia({ audio: true }),
        ]);
        stream = mic;
        const tokenData = await tokenRes.json();
        if (!tokenRes.ok || !tokenData.token) throw new Error(tokenData.error || "No Scribe token");
        if (state.closed) return cleanup();

        const params = new URLSearchParams({
          token: tokenData.token,
          model_id: "scribe_v2_realtime",
          audio_format: `pcm_${SAMPLE_RATE}`,
          commit_strategy: "vad",
          language_code: languageCode,
        });
        ws = new WebSocket(`${SCRIBE_WS_BASE}?${params}`);

        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data);
          if (msg.message_type === "committed_transcript") {
            state.committed += (msg.text ?? "") + " ";
          }
          const partial =
            msg.message_type === "partial_transcript" ? msg.text ?? "" : "";
          const count = countMatchedWords(scriptWords, state.committed + partial);
          // Only advance — never walk the count backwards on partial rewrites
          setMatchedWordCount((prev) => Math.max(prev, count));
        };

        ws.onerror = () => setListening(false);
        ws.onclose = () => setListening(false);

        ws.onopen = () => {
          if (state.closed || !stream) return;
          setListening(true);
          audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
          const source = audioContext.createMediaStreamSource(stream);
          processor = audioContext.createScriptProcessor(4096, 1, 1);
          processor.onaudioprocess = (e) => {
            if (ws?.readyState !== WebSocket.OPEN) return;
            ws.send(
              JSON.stringify({
                message_type: "input_audio_chunk",
                audio_base_64: floatTo16BitPcmBase64(e.inputBuffer.getChannelData(0)),
                sample_rate: audioContext!.sampleRate,
              })
            );
          };
          source.connect(processor);
          processor.connect(audioContext.destination);
        };
      } catch (err) {
        console.error("Scribe tracking unavailable:", err);
        cleanup();
      }
    };

    start();
    return cleanup;
  }, [active, line, languageCode]);

  return { matchedWordCount, listening };
}
