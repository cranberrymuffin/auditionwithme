import { useEffect, useRef, useState } from "react";

type RecorderStatus = "idle" | "requesting" | "recording" | "error";

// First entry the browser actually supports wins — Chrome/Edge take vp9,
// Safari/Firefox fall back down the list.
const MIME_TYPES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

function pickMimeType(): string | undefined {
  return MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

/**
 * Camera + mic capture for rehearsal self-tapes.
 *
 * `start()` opens the camera and begins recording; the live `stream` is
 * exposed so the caller can bind it to a preview <video>'s srcObject.
 * `stop()` resolves with the finished recording as a Blob and releases the
 * camera. Permission failures land in `error` rather than throwing.
 */
export function useSelfTapeRecorder() {
  const [status, setStatus] = useState<RecorderStatus>("idle");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    const cleanup = () => {
      if (recorderRef.current?.state === "recording") {
        recorderRef.current.stop();
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
    return cleanup;
  }, []);

  const start = async () => {
    setError(null);
    setStatus("requesting");
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
    } catch (err) {
      console.error("Self-tape camera unavailable:", err);
      setStatus("error");
      setError(
        "We couldn't access your camera. Check your browser permissions and try again.",
      );
      return;
    }

    streamRef.current = media;
    setStream(media);
    chunksRef.current = [];
    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(media, mimeType ? { mimeType } : undefined);
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorderRef.current = recorder;
    recorder.start();
    setStatus("recording");
  };

  const stop = async (): Promise<Blob | null> => {
    const recorder = recorderRef.current;
    if (!recorder) return null;

    const blob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () =>
        resolve(new Blob(chunksRef.current, { type: recorder.mimeType }));
      recorder.stop();
    });

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
    setStream(null);
    setStatus("idle");
    return blob;
  };

  return { status, stream, start, stop, error };
}
