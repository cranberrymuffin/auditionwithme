import { useEffect, useRef, useState } from "react";
import { checkSemanticLineMatch } from "../lib/script";
import {
  assessLine,
  extractKeyterms,
  PATIENT_HOLD_MS,
  quietAdvance,
  quietFor,
  semanticMatchMayAdvance,
  shouldTrySemanticFallback,
  SILENCE_RMS,
  type QuietInputs,
} from "../lib/lineMatch";
import { apiFetch } from "../lib/api";
import { logAudioEvent } from "../lib/audioDiagnostics";
import type { LineCompletion } from "../lib/takeMetrics";

const SCRIBE_WS_BASE = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
const SAMPLE_RATE = 16000;
// How often the mic level is sampled and the silence-advance rule re-checked.
const MIC_LEVEL_POLL_MS = 200;
// ScriptProcessorNode buffer: 256 ms at 16 kHz, inside the 0.1–1 s chunk
// size ElevenLabs recommends.
const CHUNK_SAMPLES = 4096;
// Audio captured before the socket opens is held and sent once it does. A
// socket that takes this long isn't coming; past it, the oldest chunks go.
const MAX_BUFFERED_CHUNKS = Math.ceil((10 * SAMPLE_RATE) / CHUNK_SAMPLES);

// Each line opens its own Scribe socket, and each socket needs a fresh
// single-use token — a round trip through /api/eleven-account to ElevenLabs.
// The next line's token is fetched while the current one is live, so a new
// line only waits on the WebSocket handshake. Tokens expire 15 minutes
// after minting; one held longer than this (a long pause) is dropped.
const TOKEN_MAX_AGE_MS = 10 * 60 * 1000;
let heldToken: { token: Promise<string>; fetchedAt: number } | null = null;

async function fetchScribeToken(): Promise<string> {
  const tokenRes = await apiFetch("/api/eleven-account", { method: "POST" });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok || !tokenData.token) throw new Error(tokenData.error || "No Scribe token");
  return tokenData.token;
}

/** A token for a new socket: the prefetched one if it's still fresh (or a
 * fresh fetch if prefetching failed), otherwise a fresh fetch. */
function takeScribeToken(): Promise<string> {
  const held = heldToken;
  heldToken = null;
  if (!held || Date.now() - held.fetchedAt > TOKEN_MAX_AGE_MS) return fetchScribeToken();
  return held.token.catch(() => fetchScribeToken());
}

function prefetchScribeToken(): void {
  if (heldToken) return;
  const token = fetchScribeToken();
  token.catch(() => {}); // takeScribeToken retries; nothing to report here
  heldToken = { token, fetchedAt: Date.now() };
}

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
 * matches incremental transcripts against `line` with `assessLine` (the
 * matched count never regresses). Returns the matched
 * word count plus whether tracking is actually live (mic + socket up), so the
 * caller can fall back to manual advance when it isn't.
 *
 * Takes the caller's own mic stream (the self-tape recorder's) rather than
 * opening a second `getUserMedia` of its own: `active` only ever goes true
 * once a role is selected, which is exactly when that stream already exists,
 * and a second concurrent mic session is exactly the kind of thing that can
 * knock iOS's shared audio session into an interrupted state — surfacing as
 * cues that mysteriously fail to play right around a line boundary.
 *
 * Also credits the line when the actor goes quiet with most of it heard
 * (`quietAdvance` in lib/lineMatch.ts): no new Scribe text AND a quiet mic,
 * measured by an AnalyserNode on the boosted mic signal. A short quiet is
 * enough once the line's ending has been heard; otherwise it waits out the
 * much longer patient hold, and only then tries the semantic fallback.
 *
 * `lineCompletionRef` holds when (client time of the Scribe message, of the
 * semantic match resolving, or of a quiet rule firing) and how the
 * current line was first credited as fully matched — the start of the
 * reader-latency sample in lib/takeMetrics.ts. Null until then; reset whenever the line changes.
 */
export function useScribeTracking(active: boolean, line: string, languageCode = "en", micStream: MediaStream | null) {
  const [matchedWordCount, setMatchedWordCount] = useState(0);
  const [listening, setListening] = useState(false);
  const lineCompletionRef = useRef<LineCompletion | null>(null);

  useEffect(() => {
    setMatchedWordCount(0);
    lineCompletionRef.current = null;
    if (!active || !line.trim() || !micStream) return;
    logAudioEvent("scribe", `activating for "${line.slice(0, 24)}"`);

    const scriptWords = line.split(/\s+/).filter(Boolean);
    const state = {
      committed: "",
      partial: "",
      closed: false,
      semanticChecked: "",
      matchedCount: 0,
      endingHeard: false,
      lastTextChangeAt: null as number | null,
      lastMicActiveAt: null as number | null,
      // Scribe's VAD committed the segment and no new speech has come since.
      scribeHeardPause: false,
    };
    let ws: WebSocket | null = null;
    let audioContext: AudioContext | null = null;
    let processor: ScriptProcessorNode | null = null;
    let micLevelTimer: ReturnType<typeof setInterval> | null = null;

    const cleanup = () => {
      state.closed = true;
      if (micLevelTimer) clearInterval(micLevelTimer);
      processor?.disconnect();
      audioContext?.close().catch(() => {});
      if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
      setListening(false);
      logAudioEvent("scribe", "deactivated");
    };

    // Chunks captured while the socket is still opening. The actor starts
    // speaking the moment the reader's cue ends, which is exactly when this
    // effect runs, so without the buffer their first words would go to a
    // socket that isn't there yet.
    const pending: string[] = [];
    const sendChunk = (chunk: string) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(chunk);
        return;
      }
      pending.push(chunk);
      if (pending.length > MAX_BUFFERED_CHUNKS) pending.shift();
    };

    const startCapture = () => {
      audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
      logAudioEvent("scribe", `mic ctx created, initial state=${audioContext.state}`);
      // Safari can hand back a context that isn't running yet, which would
      // otherwise leave onaudioprocess silently never firing.
      void audioContext.resume().then(
        () => logAudioEvent("scribe", `mic ctx resume() resolved, state=${audioContext?.state}`),
        (err) => logAudioEvent("scribe", `mic ctx resume() rejected: ${err}`),
      );
      const source = audioContext.createMediaStreamSource(micStream);
      // Browser autoGainControl still leaves quiet mic input under Scribe's
      // VAD threshold, so boost the signal ourselves before sending it.
      const gain = audioContext.createGain();
      gain.gain.value = 3;
      processor = audioContext.createScriptProcessor(CHUNK_SAMPLES, 1, 1);
      processor.onaudioprocess = (e) => {
        if (state.closed) return;
        sendChunk(
          JSON.stringify({
            message_type: "input_audio_chunk",
            audio_base_64: floatTo16BitPcmBase64(e.inputBuffer.getChannelData(0)),
            sample_rate: audioContext!.sampleRate,
          })
        );
      };
      // ScriptProcessorNode only fires once it's part of a live graph
      // reaching the destination, but the actual point is capturing this
      // 3x-boosted mic signal, not playing it back — routing it to the
      // destination directly would echo the user's own voice out the
      // speaker at 3x gain, which on a phone (mic and speaker inches
      // apart) is a feedback howl waiting to happen. A muted node keeps
      // the graph running without making any of that audible.
      const silent = audioContext.createGain();
      silent.gain.value = 0;
      source.connect(gain);
      gain.connect(processor);
      processor.connect(silent);
      silent.connect(audioContext.destination);

      // Mic level for the silence-advance rule, read off the same boosted
      // signal Scribe gets. Fed into the muted node like the processor,
      // so it's pulled by the graph without ever being audible.
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      gain.connect(analyser);
      analyser.connect(silent);
      const samples = new Float32Array(analyser.fftSize);
      state.lastMicActiveAt = Date.now();
      micLevelTimer = setInterval(() => {
        if (state.closed) return;
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
        const now = Date.now();
        if (Math.sqrt(sum / samples.length) >= SILENCE_RMS) state.lastMicActiveAt = now;
        if (lineCompletionRef.current) return;
        const inputs: QuietInputs = {
          scriptWords,
          progress: { matched: state.matchedCount, endingHeard: state.endingHeard },
          msSinceTextChange: state.lastTextChangeAt === null ? null : now - state.lastTextChangeAt,
          // Our mic level reads the raw signal, so in a noisy room (HVAC,
          // traffic) it may never drop under SILENCE_RMS. Scribe's VAD runs
          // on background-filtered audio; once it has committed the
          // segment, take its word that the actor stopped.
          msSinceMicActive: state.scribeHeardPause
            ? now - (state.lastTextChangeAt ?? now)
            : state.lastMicActiveAt === null ? null : now - state.lastMicActiveAt,
        };
        const rule = quietAdvance(inputs);
        if (rule) {
          logAudioEvent(
            "scribe",
            rule === "ending"
              ? "line's ending heard and actor went quiet, advancing"
              : "actor held a long pause with nearly all of the line heard, advancing",
          );
          // An ending-heard advance is word detection, just with a word
          // or two in the middle misheard, so it's counted with full matches.
          lineCompletionRef.current = { kind: rule === "ending" ? "auto" : "silence", at: now };
          setMatchedWordCount(scriptWords.length);
          return;
        }

        // Still not credited after the whole patient hold — maybe the
        // actor paraphrased. Ask the semantic fallback whether what Scribe
        // did transcribe still conveys the line, rather than leave them
        // stuck on manual advance. Once per distinct transcript, and only
        // once word matching has already credited most of the line —
        // otherwise a pause partway through a monologue reads as "done"
        // and the scene partner cuts the actor off (see lib/lineMatch.ts).
        const quiet = quietFor(inputs);
        const heard = (state.committed + state.partial).trim();
        if (
          quiet === null ||
          quiet < PATIENT_HOLD_MS ||
          heard === state.semanticChecked ||
          !shouldTrySemanticFallback(scriptWords, state.matchedCount, heard)
        ) {
          return;
        }
        state.semanticChecked = heard;
        logAudioEvent("scribe", "word match stalled through a long pause, trying semantic fallback");
        void checkSemanticLineMatch(line, heard).then((match) => {
          if (state.closed || !match || lineCompletionRef.current) return;
          if (!semanticMatchMayAdvance(scriptWords, heard)) {
            logAudioEvent("scribe", "semantic match ignored: long line's ending not heard yet");
            return;
          }
          logAudioEvent("scribe", "semantic fallback matched line");
          lineCompletionRef.current = { kind: "semantic", at: Date.now() };
          setMatchedWordCount(scriptWords.length);
        });
      }, MIC_LEVEL_POLL_MS);
    };

    const start = async () => {
      try {
        const token = await takeScribeToken();
        if (state.closed) return;
        // For the actor's next line, while this one plays out.
        prefetchScribeToken();

        const params = new URLSearchParams({
          token,
          model_id: "scribe_v2_realtime",
          audio_format: `pcm_${SAMPLE_RATE}`,
          commit_strategy: "vad",
          language_code: languageCode,
          // Strips filler words/disfluencies from the transcript so they
          // can't occupy a match slot or otherwise muddy word-for-word
          // comparison against the script line.
          no_verbatim: "true",
          // Self-tape recording happens in whatever room the actor is in,
          // not a treated studio — road noise, roommates, HVAC. Scribe can
          // suppress that before transcribing instead of it competing with
          // the actual line for recognition.
          filter_background_audio: "true",
        });
        for (const term of extractKeyterms(line)) params.append("keyterms", term);
        ws = new WebSocket(`${SCRIBE_WS_BASE}?${params}`);

        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data);
          const text: string = msg.text ?? "";
          if (msg.message_type === "committed_transcript") {
            // A commit restating the in-progress partial isn't new speech.
            if (text.trim() && text !== state.partial) state.lastTextChangeAt = Date.now();
            state.committed += text + " ";
            state.partial = "";
            state.scribeHeardPause = true;
          } else if (msg.message_type === "partial_transcript" && text !== state.partial) {
            state.partial = text;
            state.lastTextChangeAt = Date.now();
            state.scribeHeardPause = false;
          }
          const progress = assessLine(scriptWords, state.committed + state.partial);
          // Only advance — never walk the count backwards on partial rewrites
          state.matchedCount = Math.max(state.matchedCount, progress.matched);
          // Not sticky: a rewritten partial that drops the last word un-hears it.
          state.endingHeard = progress.endingHeard;
          setMatchedWordCount((prev) => Math.max(prev, progress.matched));
          if (progress.matched >= scriptWords.length && !lineCompletionRef.current) {
            lineCompletionRef.current = { kind: "auto", at: Date.now() };
          }
        };

        ws.onerror = () => setListening(false);
        ws.onclose = () => setListening(false);

        ws.onopen = () => {
          if (state.closed) return;
          setListening(true);
          if (pending.length) {
            logAudioEvent("scribe", `socket open, sending ${pending.length} buffered chunks (${Math.round((pending.length * CHUNK_SAMPLES * 1000) / SAMPLE_RATE)}ms)`);
          }
          for (const chunk of pending) ws!.send(chunk);
          pending.length = 0;
        };
      } catch (err) {
        console.error("Scribe tracking unavailable:", err);
        cleanup();
      }
    };

    try {
      startCapture();
    } catch (err) {
      console.error("Scribe mic capture unavailable:", err);
      cleanup();
      return;
    }
    start();
    return cleanup;
  }, [active, line, languageCode, micStream]);

  return { matchedWordCount, listening, lineCompletionRef };
}
