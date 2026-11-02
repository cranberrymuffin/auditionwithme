import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

// The iOS app's own media hardware (ios/App/App/NativeMediaPlugin.swift,
// backed by MediaSessionController.swift). Only ever used when IS_NATIVE —
// browsers keep getUserMedia, MediaRecorder and Web Audio.

export type MediaMode = "idle" | "playback" | "capture";

export type MediaState = {
  mode: MediaMode;
  mic: boolean;
  camera: boolean;
  /** Capture leases currently held; the mic is on only while this is > 0. */
  leases: number;
};

interface NativeMediaPlugin {
  getState(): Promise<MediaState>;

  // Scene-partner playback (playback-only engine; never touches the mic).
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

  addListener(
    event: "mediaState",
    listener: (event: MediaState & { reason: string }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(event: "lineEnded", listener: (event: { token: number }) => void): Promise<PluginListenerHandle>;
}

export const NativeMedia = registerPlugin<NativeMediaPlugin>("NativeMedia");
