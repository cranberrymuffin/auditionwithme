// A recorded take (whatever MediaRecorder produced: webm/opus in Chrome,
// mp4/aac in Safari) as 16 kHz 16-bit little-endian mono PCM — the one input
// format ElevenLabs speech-to-speech documents by name (file_format
// pcm_s16le_16), and the one it converts fastest. Decoding here also means
// api/sts.ts never has to care which browser recorded the take.

const SAMPLE_RATE = 16_000;

export async function toPcm16kMono(blob: Blob): Promise<Uint8Array> {
  // decodeAudioData resamples to its context's rate, so a 16 kHz context
  // does the resampling; nothing is ever rendered on it.
  const context = new OfflineAudioContext(1, 1, SAMPLE_RATE);
  const decoded = await context.decodeAudioData(await blob.arrayBuffer());
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) =>
    decoded.getChannelData(i),
  );
  const pcm = new DataView(new ArrayBuffer(decoded.length * 2));
  for (let i = 0; i < decoded.length; i += 1) {
    let sample = 0;
    for (const channel of channels) sample += channel[i];
    sample = Math.max(-1, Math.min(1, sample / channels.length));
    pcm.setInt16(i * 2, Math.round(sample * 0x7fff), true);
  }
  return new Uint8Array(pcm.buffer);
}

export function toBase64(bytes: Uint8Array): string {
  // In chunks: spreading a whole take into one fromCharCode call overflows
  // the argument limit.
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
