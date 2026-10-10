import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAuthRateLimited } from "./_entitlement.js";
import {
  fetchElevenLabs,
  holdPregenIfBusy,
  relayConcurrency,
  type ConcurrencyReading,
} from "./_elevenlabs.js";

// Coached lines (CoachScenePartners.tsx): the actor's own read of a scene
// partner's line, re-voiced as that character by ElevenLabs speech-to-speech
// — the actor's timing, emphasis and emotion, the character's voice. The
// actor's recording is the whole performance, so unlike api/tts.ts there's
// no direction, emotion or context to apply. ElevenLabs recommends the
// multilingual model even for English.
const STS_MODEL = "eleven_multilingual_sts_v2";

// The client sends 16 kHz 16-bit mono PCM (src/lib/pcm.ts), the input
// ElevenLabs says converts fastest: 32,000 bytes a second. Capped at the
// client's own recording limit (MAX_COACH_TAKE_SECONDS in
// CoachScenePartners.tsx), which also keeps the base64 body well under
// Vercel's 4.5 MB request limit.
const PCM_BYTES_PER_SECOND = 32_000;
const MAX_TAKE_SECONDS = 60;
const MAX_AUDIO_BYTES = PCM_BYTES_PER_SECOND * MAX_TAKE_SECONDS;

const VOICE_ID_PATTERN = /^[A-Za-z0-9]{1,64}$/;

// Pre-generation hold: see holdPregenIfBusy in _elevenlabs.ts.
const lastSeenConcurrency: ConcurrencyReading = { current: 0, max: 3, updatedAt: 0 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const auth = await requireAuthRateLimited(req, res, {
    bucket: "sts",
    maxPerWindow: 300,
  });
  if (!auth) return;

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "ELEVENLABS_API_KEY is not set" });
  }

  const { voiceId, audio } = (req.body ?? {}) as {
    voiceId?: string;
    /** Base64 of the take as 16 kHz 16-bit little-endian mono PCM. */
    audio?: string;
  };
  if (typeof voiceId !== "string" || !VOICE_ID_PATTERN.test(voiceId)) {
    return res.status(400).json({ error: "No voice chosen for this character" });
  }
  if (typeof audio !== "string" || !audio) {
    return res.status(400).json({ error: "No recording provided" });
  }
  const pcm = Buffer.from(audio, "base64");
  // Samples are two bytes each; anything else isn't the PCM we asked for.
  if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) {
    return res.status(400).json({ error: "The recording couldn't be read" });
  }
  if (pcm.byteLength > MAX_AUDIO_BYTES) {
    return res
      .status(413)
      .json({ error: `Coached lines can be up to ${MAX_TAKE_SECONDS} seconds long` });
  }

  if (holdPregenIfBusy(req, res, lastSeenConcurrency)) return;

  const form = new FormData();
  form.append("audio", new Blob([pcm]), "line.pcm");
  form.append("model_id", STS_MODEL);
  form.append("file_format", "pcm_s16le_16");
  // Takes are recorded wherever the actor happens to be; room noise left in
  // would come out re-voiced as part of the character's line.
  form.append("remove_background_noise", "true");

  try {
    const upstream = await fetchElevenLabs(
      `https://api.elevenlabs.io/v1/speech-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "xi-api-key": apiKey },
        body: form,
      },
    );

    relayConcurrency(upstream, res, lastSeenConcurrency);

    if (!upstream.ok) {
      const err = await upstream.text();
      console.error("ElevenLabs speech-to-speech error:", err);
      const retryAfter = upstream.headers.get("retry-after");
      if (retryAfter) res.setHeader("Retry-After", retryAfter);
      let message = err;
      try {
        message =
          (JSON.parse(err) as { detail?: { message?: string } }).detail?.message ?? err;
      } catch {
        // not JSON: pass the text along as is
      }
      // A rejected key (say, one without the speech_to_speech permission) is
      // our misconfiguration, not the actor's session: don't send it back as
      // a 401 the client could take for their own sign-in.
      const status =
        upstream.status === 401 || upstream.status === 403 ? 502 : upstream.status;
      return res.status(status).json({ error: message });
    }

    const converted = await upstream.arrayBuffer();
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", converted.byteLength);
    res.setHeader("X-TTS-Model", STS_MODEL);
    return res.status(200).send(Buffer.from(converted));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Speech-to-speech error:", message);
    return res.status(500).json({ error: message });
  }
}
