import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

// The iOS app's own media hardware (ios/App/App/NativeMediaPlugin.swift,
// MediaSessionController.swift and CameraRecorder.swift). Only ever used
// when IS_NATIVE — browsers keep getUserMedia, MediaRecorder and Web Audio.
//
// The camera and mic are taken as a capture lease and must be handed back:
// they're on only while a lease is held. Only useSelfTapeRecorder.native.ts
// takes leases.

export type MediaMode = "idle" | "playback" | "capture";

export type MediaState = {
  mode: MediaMode;
  mic: boolean;
  camera: boolean;
  /** Capture leases currently held; the mic is on only while this is > 0. */
  leases: number;
};

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
  getState(): Promise<MediaState>;

  // Scene-partner playback.
  /** Whether a line's audio is already stored natively (survives restarts). */
  hasLine(options: { key: string }): Promise<{ loaded: boolean }>;
  /** Stores a line's audio (base64) under its cache key. */
  loadLine(options: { key: string; base64: string }): Promise<void>;
  /** Plays a stored line; resolves with a token once it's playing. The
   * matching `lineEnded` event carries the same token. */
  playLine(options: { key: string; rate: number; volume: number }): Promise<{ token: number }>;
  stopLine(): Promise<void>;
  setRate(options: { rate: number }): Promise<void>;
  setVolume(options: { volume: number }): Promise<void>;

  // Capture (camera + mic), by lease.
  /** Turns the mic on (and the camera, if asked) and returns the lease that
   * keeps them on. Asks for permission first if needed. */
  acquireCapture(options: {
    reason: string;
    camera: boolean;
    micId?: string | null;
    cameraId?: string | null;
    zoom?: number | null;
  }): Promise<{ leaseId: number; camera?: CameraInfo }>;
  /** Hands a lease back; the last one turns the camera and mic off.
   * Releasing the same lease twice is harmless. */
  releaseCapture(options: { leaseId: number; reason: string }): Promise<void>;
  releaseAll(options: { reason: string }): Promise<void>;
  /** While on, `pcm` events carry 16 kHz 16-bit mono PCM for Scribe. */
  setPcmStreaming(options: { enabled: boolean }): Promise<void>;
  listDevices(): Promise<{ cameras: MediaDevice[]; mics: MediaDevice[] }>;
  setZoom(options: { zoom: number }): Promise<void>;
  showPreview(options: { x: number; y: number; width: number; height: number; cornerRadius: number }): Promise<void>;
  hidePreview(): Promise<void>;

  // Recording (needs a lease with the camera on).
  startRecording(): Promise<void>;
  pauseRecording(): Promise<void>;
  resumeRecording(): Promise<void>;
  stopRecording(): Promise<RecordedTake | { path: null }>;

  // Take files (Application Support/tapes).
  /** The tapes folder's path right now. It moves when iOS moves the app's
   * data container (reinstall, update), so store file names, not paths. */
  getTapesDir(): Promise<{ path: string }>;
  /** Moves a just-recorded take from the temp folder to where takes are
   * kept, named `fileName`. */
  keepTake(options: { path: string; tapeId: string; fileName: string }): Promise<RecordedTake>;
  deleteTakeFile(options: { path: string }): Promise<void>;
  fileSize(options: { path: string }): Promise<{ size: number }>;
  /** Every file in the tapes folder; `modifiedAt` is ms since 1970. */
  listTakeFiles(): Promise<{ files: { name: string; size: number; modifiedAt: number }[] }>;
  /** The phone's free and total space — what limits how many more takes fit. */
  storageInfo(): Promise<{ freeBytes: number; totalBytes: number }>;

  addListener(
    event: "mediaState",
    listener: (event: MediaState & { reason: string }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(event: "lineEnded", listener: (event: { token: number }) => void): Promise<PluginListenerHandle>;
  addListener(event: "micLevel", listener: (event: { rms: number }) => void): Promise<PluginListenerHandle>;
  addListener(event: "pcm", listener: (event: { pcm: string }) => void): Promise<PluginListenerHandle>;
  addListener(
    event: "cameraInterrupted",
    listener: (event: { interrupted: boolean }) => void,
  ): Promise<PluginListenerHandle>;
  /** Everything was released without being asked — today only when the app
   * goes to the background. `take` is the take that was in progress,
   * finished and ready to keep. */
  addListener(
    event: "mediaReleased",
    listener: (event: { reason: "background"; take?: RecordedTake }) => void,
  ): Promise<PluginListenerHandle>;
}

export const NativeMedia = registerPlugin<NativeMediaPlugin>("NativeMedia");
