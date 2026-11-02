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

  addListener(
    event: "mediaState",
    listener: (event: MediaState & { reason: string }) => void,
  ): Promise<PluginListenerHandle>;
}

export const NativeMedia = registerPlugin<NativeMediaPlugin>("NativeMedia");
