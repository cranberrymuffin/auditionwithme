// The actor's chosen camera, microphone and speaker, remembered on this
// device so the next rehearsal opens the same ones. Browsers may hand out a
// new id for the same device (Safari per session, Chrome once site data is
// cleared), so the name is kept too and matched when the id has moved on.
// A device that's gone entirely falls back to the browser's default.

export type DeviceKind = "videoinput" | "audioinput" | "audiooutput";
export type DeviceChoice = { id: string; label: string };

const KEYS: Record<DeviceKind, string> = {
  videoinput: "awm:camera",
  audioinput: "awm:mic",
  audiooutput: "awm:speaker",
};

/** Strips Chrome's "Default - " prefix from the default device's label. */
export const deviceName = (label: string) => label.replace(/^Default - /, "");

export function preferredDevice(kind: DeviceKind): DeviceChoice | null {
  try {
    const stored = localStorage.getItem(KEYS[kind]);
    const choice = stored ? (JSON.parse(stored) as DeviceChoice) : null;
    return choice?.id ? choice : null;
  } catch {
    return null;
  }
}

/** `null` forgets the choice, back to the browser's default. */
export function setPreferredDevice(kind: DeviceKind, choice: DeviceChoice | null): void {
  try {
    if (choice?.id) localStorage.setItem(KEYS[kind], JSON.stringify(choice));
    else localStorage.removeItem(KEYS[kind]);
  } catch {
    // Storage blocked (private mode): the choice just isn't remembered.
  }
}

/** The id to open for the remembered device: its own if still listed, else
 * the id now carried by a device of the same name. Null when there's no
 * choice. Labels are blank until camera/mic access is granted, so before
 * that the stored id is tried as-is and the caller falls back if it fails. */
export async function resolvePreferredDevice(kind: DeviceKind): Promise<string | null> {
  const choice = preferredDevice(kind);
  if (!choice) return null;
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    if (all.some((d) => d.kind === kind && d.deviceId === choice.id)) return choice.id;
    const renamed = all.find(
      (d) => d.kind === kind && d.label && deviceName(d.label) === choice.label,
    );
    if (renamed) {
      setPreferredDevice(kind, { id: renamed.deviceId, label: choice.label });
      return renamed.deviceId;
    }
  } catch {
    // Can't list devices: try the stored id.
  }
  return choice.id;
}

/** Chrome and Edge only; Safari and iOS play through the system output. */
export const canChooseSpeaker =
  typeof AudioContext !== "undefined" && "setSinkId" in AudioContext.prototype;

type SinkTarget = { setSinkId?: (id: string) => Promise<void> };

/** Points an <audio> element or AudioContext at the chosen speaker ("" is
 * the system default), where the browser allows it. Best-effort: a missing
 * device or an unsupported browser leaves it on the system default. */
export function routeToPreferredSpeaker(target: HTMLMediaElement | AudioContext): void {
  const sink = target as unknown as SinkTarget;
  if (typeof sink.setSinkId !== "function") return;
  void resolvePreferredDevice("audiooutput").then((id) =>
    sink.setSinkId!(id ?? "").catch(() => {}),
  );
}
