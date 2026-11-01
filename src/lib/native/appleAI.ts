import { registerPlugin } from "@capacitor/core";
import { IS_NATIVE } from "../platform";
import { logAudioEvent } from "../audioDiagnostics";

// Apple's on-device speech models and language model, through the AppleAI
// plugin in the iOS app (ios/App/App/AppleAIPlugin.swift). Recognition
// itself runs in NativeMediaPlugin, fed straight from the mic; this side
// only checks and downloads the speech model. Each
// caller checks readiness first and falls back to the cloud API it replaces
// when the device can't: browsers, iOS before 26, phones without Apple
// Intelligence, or a language Apple doesn't cover.

type SpeechStatus = "installed" | "supported" | "downloading" | "unsupported";
type ModelStatus =
  | "available"
  | "deviceNotEligible"
  | "appleIntelligenceNotEnabled"
  | "modelNotReady"
  | "unsupportedLanguage"
  | "unsupported";

interface AppleAIPlugin {
  speechStatus(options: { language: string }): Promise<{ status: SpeechStatus }>;
  installSpeech(options: { language: string }): Promise<void>;
  modelStatus(options: { language: string }): Promise<{ status: ModelStatus }>;
  semanticMatch(options: { instructions: string; prompt: string }): Promise<{ match: boolean }>;
  directLines(options: {
    instructions: string;
    prompt: string;
  }): Promise<{ lines: { row: number; markup: string }[] }>;
}

export const AppleAI = registerPlugin<AppleAIPlugin>("AppleAI");

const speechInstalled = new Set<string>();
const speechInstalling = new Set<string>();

/**
 * Whether on-device speech can follow a line in this language right now.
 * The model is a one-time download per language: the first ask starts it
 * in the background and says no, so lines use Scribe until it lands.
 */
export async function onDeviceSpeechReady(language: string): Promise<boolean> {
  if (!IS_NATIVE) return false;
  if (speechInstalled.has(language)) return true;
  try {
    const { status } = await AppleAI.speechStatus({ language });
    if (status === "installed") {
      speechInstalled.add(language);
      return true;
    }
    if (status === "supported" && !speechInstalling.has(language)) {
      speechInstalling.add(language);
      logAudioEvent("speech", `downloading the on-device model for "${language}"`);
      AppleAI.installSpeech({ language }).then(
        () => logAudioEvent("speech", `on-device model for "${language}" installed`),
        (err) => {
          speechInstalling.delete(language);
          logAudioEvent("speech", `on-device model download failed: ${err?.message ?? err}`);
        },
      );
    }
  } catch (err) {
    console.warn("On-device speech status unavailable:", err);
  }
  return false;
}

/** Whether Apple's on-device language model can answer in this language.
 * Only a yes is cached: "model not ready" clears up once it downloads. */
const modelAvailable = new Set<string>();

export async function onDeviceModelReady(language: string): Promise<boolean> {
  if (!IS_NATIVE) return false;
  if (modelAvailable.has(language)) return true;
  try {
    const { status } = await AppleAI.modelStatus({ language });
    if (status === "available") modelAvailable.add(language);
    return status === "available";
  } catch {
    return false;
  }
}
