import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

// The iOS app's own audio and camera hardware (ios/App/App/NativeMediaPlugin.swift):
// one AVAudioEngine that plays the scene partner, listens to the mic and
// mixes the take, and one AVCaptureSession for the camera. Only ever used
// when IS_NATIVE — browsers keep getUserMedia, MediaRecorder and Web Audio.

export type CameraInfo = {
  width: number;
  height: number;
  /** Null where the camera can't zoom. */
  zoomRange: { min: number; max: number } | null;
  zoom: number;
};

export type MediaDevice = { id: string; label: string };

export type RecordedTake = { path: string; size: number; mimeType: string };

interface NativeMediaPlugin {
  // Scene-partner playback.
  /** Stores a line's audio (base64) under its cache key, once per key. */
  loadLine(options: { key: string; base64: string }): Promise<void>;
  /** Plays a stored line; resolves with a token once it's playing. The
   * matching `lineEnded` event carries the same token. */
  playLine(options: { key: string; rate: number; volume: number }): Promise<{ token: number }>;
  stopLine(): Promise<void>;
  setRate(options: { rate: number }): Promise<void>;
  setVolume(options: { volume: number }): Promise<void>;

  // Mic and line tracking.
  startMic(options: { micId?: string | null }): Promise<void>;
  stopMic(): Promise<void>;
  /** Apple's on-device recognizer, fed straight from the mic. Resolves
   * with a session id that `transcript` events carry; rejects if the
   * language model isn't installed (the caller uses Scribe). */
  startTranscription(options: { language: string; contextualStrings: string[] }): Promise<{ session: number }>;
  stopTranscription(options: { session: number }): Promise<void>;
  /** While on, `pcm` events carry 16 kHz 16-bit mono PCM for Scribe. */
  setPcmStreaming(options: { enabled: boolean }): Promise<void>;

  // Camera and recording.
  listDevices(): Promise<{ cameras: MediaDevice[]; mics: MediaDevice[] }>;
  openCamera(options: { cameraId?: string | null; zoom?: number | null }): Promise<CameraInfo>;
  closeCamera(): Promise<void>;
  setZoom(options: { zoom: number }): Promise<void>;
  showPreview(options: { x: number; y: number; width: number; height: number; cornerRadius: number }): Promise<void>;
  hidePreview(): Promise<void>;
  startRecording(): Promise<void>;
  pauseRecording(): Promise<void>;
  resumeRecording(): Promise<void>;
  stopRecording(): Promise<RecordedTake | { path: null }>;
  /** Moves a just-recorded take from the temp folder to where takes are
   * kept (Application Support), named `fileName`. */
  keepTake(options: { path: string; tapeId: string; fileName: string }): Promise<RecordedTake>;
  /** Writes a take that only exists as bytes into where takes are kept. */
  storeTakeFile(options: { tapeId: string; base64: string; extension: string }): Promise<RecordedTake>;
  deleteTakeFile(options: { path: string }): Promise<void>;
  fileSize(options: { path: string }): Promise<{ size: number }>;

  addListener(event: "lineEnded", listener: (event: { token: number }) => void): Promise<PluginListenerHandle>;
  addListener(event: "micLevel", listener: (event: { rms: number }) => void): Promise<PluginListenerHandle>;
  addListener(
    event: "transcript",
    listener: (event: { session: number; text: string; isFinal: boolean }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    event: "transcriptionError",
    listener: (event: { session: number; message: string }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(event: "pcm", listener: (event: { pcm: string }) => void): Promise<PluginListenerHandle>;
  addListener(
    event: "cameraInterrupted",
    listener: (event: { interrupted: boolean }) => void,
  ): Promise<PluginListenerHandle>;
}

export const NativeMedia = registerPlugin<NativeMediaPlugin>("NativeMedia");
