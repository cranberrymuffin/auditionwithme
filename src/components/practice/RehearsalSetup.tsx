import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ReaderAudioPregenState } from "../../hooks/useReaderAudioPregen";
import { isIpad, type ZoomRange } from "../../hooks/useSelfTapeRecorder";
import {
  canChooseSpeaker,
  deviceName,
  preferredDevice,
  routeToPreferredSpeaker,
  setPreferredDevice,
  type DeviceChoice,
} from "../../lib/mediaDevices";
import SetupStep from "./SetupStep";
import NativeCameraPreview from "./NativeCameraPreview";
import { NativeMedia } from "../../lib/native/nativeMedia";
import { IS_NATIVE } from "../../lib/platform";
import { isStorageNoticeDismissed, rememberStorageNoticeDismissed } from "../../lib/storageNotice";

type RecorderStatus =
  | "idle"
  | "requesting"
  | "ready"
  | "recording"
  | "paused"
  | "error";

// If the opening lines still aren't pre-generated after this long (a busy
// account, a slow network), offer to start anyway — those lines then fetch
// live during the take instead of keeping the actor waiting here.
const START_ANYWAY_AFTER_MS = 20_000;
// Share of the scene partner's upcoming lines (the pre-generation window,
// lib/pregenSchedule.ts) ready before Start rehearsal opens up (the opening
// lines must be ready too).
const READY_TO_START_SHARE = 0.25;
// Bars in the microphone's level meter, and the level (RMS of the waveform,
// 0–1) that lights them all: ordinary speaking sits around 0.05–0.15.
const MIC_METER_BARS = 5;
const MIC_FULL_SCALE = 0.2;
// The browser's camera/mic prompt is easy to miss (or dismiss): after this
// long still waiting on it, point the actor at it.
const PERMISSION_NUDGE_AFTER_MS = 5_000;

/** Phones only have a front camera worth taping with; iPads take USB ones. */
const isPhone =
  typeof navigator !== "undefined" &&
  /iPhone|iPod|Android.*Mobile/.test(navigator.userAgent);

type DeviceOption = DeviceChoice;

/** "System default (MacBook Pro Microphone)": Chrome names the device the
 * OS currently routes "default" to; other browsers don't list it. */
function systemDefault(all: MediaDeviceInfo[], kind: MediaDeviceKind): DeviceOption {
  const entry = all.find((d) => d.kind === kind && d.deviceId === "default");
  return {
    id: "",
    label: entry?.label ? `System default (${deviceName(entry.label)})` : "System default",
  };
}

/** The cameras, mics and speakers the browser lists, by name once camera
 * and mic access has unlocked labels. Each list starts with the system
 * default (id "") — following the OS setting is a choice of its own —
 * and leaves out Chrome's "default" and "communications" aliases, which
 * name real devices also listed. */
function useDevices(refreshKey: unknown) {
  const [devices, setDevices] = useState<{
    cameras: DeviceOption[];
    mics: DeviceOption[];
    speakers: DeviceOption[];
    speakerFound: boolean;
  }>({ cameras: [], mics: [], speakers: [], speakerFound: true });
  useEffect(() => {
    const media = navigator.mediaDevices;
    if (!media?.enumerateDevices) return;
    let active = true;
    const read = () =>
      void media
        .enumerateDevices()
        .then((all) => {
          if (!active) return;
          const real = (kind: MediaDeviceKind) =>
            all
              .filter(
                (d) =>
                  d.kind === kind &&
                  d.label &&
                  d.deviceId !== "default" &&
                  d.deviceId !== "communications",
              )
              .map((d) => ({ id: d.deviceId, label: deviceName(d.label) }));
          const outputs = all.filter((d) => d.kind === "audiooutput");
          const withDefault = (kind: MediaDeviceKind) => [
            systemDefault(all, kind),
            ...real(kind),
          ];
          setDevices({
            cameras: withDefault("videoinput"),
            mics: withDefault("audioinput"),
            speakers: withDefault("audiooutput"),
            // Only browsers that can route audio to a chosen output list
            // outputs at all; elsewhere an empty list says nothing.
            speakerFound: outputs.length > 0 || !canChooseSpeaker,
          });
        })
        .catch((err) => console.warn("Couldn't list cameras and microphones:", err));
    read();
    media.addEventListener?.("devicechange", read);
    return () => {
      active = false;
      media.removeEventListener?.("devicechange", read);
    };
  }, [refreshKey]);
  return devices;
}

/** useDevices in the iOS app: the phone's cameras and audio inputs, read
 * once the camera is on. The speaker follows the system's route there. */
function useNativeDevices(cameraOn: unknown) {
  const [devices, setDevices] = useState<{
    cameras: DeviceOption[];
    mics: DeviceOption[];
    speakers: DeviceOption[];
    speakerFound: boolean;
  }>({ cameras: [], mics: [], speakers: [], speakerFound: true });
  useEffect(() => {
    if (!cameraOn) return;
    let active = true;
    void NativeMedia.listDevices()
      .then(({ cameras, mics }) => {
        if (!active) return;
        const systemDefaultOption = { id: "", label: "System default" };
        setDevices({
          cameras: [systemDefaultOption, ...cameras],
          mics: [systemDefaultOption, ...mics],
          speakers: [],
          speakerFound: true,
        });
      })
      .catch((err) => console.warn("Couldn't list the phone's cameras and microphones:", err));
    return () => {
      active = false;
    };
  }, [cameraOn]);
  return devices;
}

const useDeviceList = IS_NATIVE ? useNativeDevices : useDevices;

/** The picker's value: the remembered device if it's listed, else the
 * system default. */
function chosenId(kind: "videoinput" | "audioinput" | "audiooutput", options: DeviceOption[]): string {
  const id = preferredDevice(kind)?.id ?? "";
  return options.some((o) => o.id === id) ? id : "";
}

function DevicePicker({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: DeviceOption[];
  onChange: (choice: DeviceChoice | null) => void;
}) {
  return (
    <select
      className="select device-picker"
      aria-label={label}
      value={value}
      onChange={(event) =>
        onChange(options.find((o) => o.id === event.target.value && o.id) ?? null)
      }
    >
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** Plays a short two-note chime: enough to hear, nothing to sit through. */
function playTestChime(context: AudioContext) {
  const start = context.currentTime + 0.05;
  [660, 880].forEach((frequency, i) => {
    const at = start + i * 0.22;
    const tone = context.createOscillator();
    const gain = context.createGain();
    tone.type = "sine";
    tone.frequency.value = frequency;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.25, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, at + 0.5);
    tone.connect(gain).connect(context.destination);
    tone.start(at);
    tone.stop(at + 0.5);
  });
}

/** Live level of the microphone in `stream`, as bars that light up while
 * the actor speaks. Updates the bars directly each frame, not via state. */
function MicLevel({
  stream,
  context,
}: {
  stream: MediaStream;
  context: AudioContext;
}) {
  const barsRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let frame = 0;
    const draw = () => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      const level = Math.min(
        1,
        Math.sqrt(sum / samples.length) / MIC_FULL_SCALE,
      );
      const lit = Math.round(level * MIC_METER_BARS);
      barsRef.current?.querySelectorAll("i").forEach((bar, i) => {
        bar.classList.toggle("is-lit", i < lit);
      });
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => {
      cancelAnimationFrame(frame);
      source.disconnect();
    };
  }, [stream, context]);
  return (
    <span className="mic-level" ref={barsRef} aria-hidden="true">
      {Array.from({ length: MIC_METER_BARS }, (_, i) => (
        <i key={i} />
      ))}
    </span>
  );
}

/** MicLevel in the iOS app, from the native engine's level readings. */
function NativeMicLevel() {
  const barsRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const listener = NativeMedia.addListener("micLevel", ({ rms }) => {
      // The engine reports the line tracker's 3x-boosted level; this meter
      // reads the raw one, as MicLevel does.
      const level = Math.min(1, rms / 3 / MIC_FULL_SCALE);
      const lit = Math.round(level * MIC_METER_BARS);
      barsRef.current?.querySelectorAll("i").forEach((bar, i) => {
        bar.classList.toggle("is-lit", i < lit);
      });
    });
    return () => {
      void listener.then((handle) => handle.remove());
    };
  }, []);
  return (
    <span className="mic-level" ref={barsRef} aria-hidden="true">
      {Array.from({ length: MIC_METER_BARS }, (_, i) => (
        <i key={i} />
      ))}
    </span>
  );
}

/**
 * Step 4: the last stop before the take. The scene partner's lines are
 * pre-generated while the camera and microphone are set up beside them;
 * a status line says what Start rehearsal is still waiting on.
 *
 * Rendered by Rehearsal itself, not as a step of its own, so Start's click
 * unlocks audio on the very player the take then uses.
 */
export default function RehearsalSetup({
  scriptName,
  onGoToStep,
  pregen,
  willRecord,
  cameraStatus,
  cameraStream,
  cameraError,
  onRetryCamera,
  onSwitchDevice,
  cameraZoom,
  onZoom,
  scriptSaved,
  onStart,
  onPracticeRun,
  onBack,
  nativePreview = false,
}: {
  scriptName: string;
  /** Back to an earlier step (1-based), from the header's step bars. */
  onGoToStep?: (step: number) => void;
  pregen: ReaderAudioPregenState;
  /** Reading a role: there's a self-tape, so a camera to set up. */
  willRecord: boolean;
  cameraStatus: RecorderStatus;
  cameraStream: MediaStream | null;
  cameraError: string | null;
  onRetryCamera: () => void;
  /** Reopens the camera and mic with a different camera or mic. */
  onSwitchDevice: (kind: "videoinput" | "audioinput", choice: DeviceChoice | null) => void;
  /** The camera's zoom range and level, null where it can't zoom. */
  cameraZoom: { range: ZoomRange; value: number } | null;
  onZoom: (value: number) => void;
  /** The take is saved under the script's record, so it must exist. */
  scriptSaved: boolean;
  onStart: () => void;
  /** Run the scene without recording — only offered when there'd be a tape. */
  onPracticeRun?: () => void;
  /** Back to the scene partners step. */
  onBack: () => void;
  /** iOS app: the camera is drawn natively, and there's no stream. */
  nativePreview?: boolean;
}) {
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const [startAnywayOffered, setStartAnywayOffered] = useState(false);
  const [storageNoticeDismissed, setStorageNoticeDismissed] = useState(isStorageNoticeDismissed);
  const dismissStorageNotice = () => {
    rememberStorageNoticeDismissed();
    setStorageNoticeDismissed(true);
  };

  useEffect(() => {
    if (previewRef.current) previewRef.current.srcObject = cameraStream;
  }, [cameraStream]);

  useEffect(() => {
    const timer = setTimeout(
      () => setStartAnywayOffered(true),
      START_ANYWAY_AFTER_MS,
    );
    return () => clearTimeout(timer);
  }, []);

  const linesReady =
    pregen.done ||
    (pregen.canStart &&
      pregen.total > 0 &&
      pregen.ready / pregen.total >= READY_TO_START_SHARE);
  const linesStartable = linesReady || startAnywayOffered || pregen.failed > 0;
  const allLinesReady =
    pregen.done || (pregen.total > 0 && pregen.ready >= pregen.total);
  // In the iOS app there's no stream: the camera is on once it's ready.
  const cameraOn = Boolean(cameraStream) || (nativePreview && cameraStatus === "ready");
  const cameraReady = !willRecord || cameraOn;
  const canStart =
    linesStartable && cameraReady && (!willRecord || scriptSaved);
  const directing =
    pregen.waitingForDirection || (pregen.total === 0 && !pregen.done);

  // Step 4's own audio graph for the speaker and mic checks, apart from the
  // player's (which is mixed into the self-tape). Browsers may start it
  // suspended until a gesture, so any click on the step resumes it.
  // In the iOS app the context is made only when Test is tapped: WebKit can
  // reconfigure the shared audio session when one starts, which the native
  // camera and mic (on from this step) shouldn't have to ride out.
  const [checkAudio, setCheckAudio] = useState<AudioContext | null>(null);
  useEffect(() => {
    if (IS_NATIVE) return;
    const context = new AudioContext();
    const resume = () => void context.resume().catch(() => {});
    resume();
    routeToPreferredSpeaker(context);
    window.addEventListener("pointerdown", resume);
    setCheckAudio(context);
    return () => {
      window.removeEventListener("pointerdown", resume);
      void context.close().catch(() => {});
    };
  }, []);
  const available = useDeviceList(nativePreview ? cameraOn : cameraStream);
  const [speakerId, setSpeakerId] = useState(
    () => preferredDevice("audiooutput")?.id ?? "",
  );
  const chooseSpeaker = (choice: DeviceChoice | null) => {
    setSpeakerId(choice?.id ?? "");
    setPreferredDevice("audiooutput", choice);
    // So Test plays through it straight away.
    if (checkAudio) routeToPreferredSpeaker(checkAudio);
  };
  const speakerLabel =
    available.speakers.find((s) => s.id === speakerId)?.label ??
    available.speakers[0]?.label ??
    "System default";
  const testSpeakers = () => {
    let context = checkAudio;
    if (!context && IS_NATIVE) {
      context = new AudioContext();
      setCheckAudio(context);
    }
    if (!context) return;
    void context.resume().catch(() => {});
    playTestChime(context);
  };
  // The on-demand context (iOS app) still closes with the step.
  const checkAudioRef = useRef(checkAudio);
  checkAudioRef.current = checkAudio;
  useEffect(() => {
    if (!IS_NATIVE) return;
    return () => void checkAudioRef.current?.close().catch(() => {});
  }, []);

  const [permissionSlow, setPermissionSlow] = useState(false);
  useEffect(() => {
    setPermissionSlow(false);
    if (!willRecord || cameraOn || cameraStatus === "error") return;
    const timer = setTimeout(
      () => setPermissionSlow(true),
      PERMISSION_NUDGE_AFTER_MS,
    );
    return () => clearTimeout(timer);
  }, [willRecord, cameraOn, cameraStatus]);

  const videoTrack = cameraStream?.getVideoTracks()[0];
  const audioTrack = cameraStream?.getAudioTracks()[0];
  // The app has no tracks: the device is on with the camera, named by the
  // actor's choice if they made one.
  const nativeLabel = (kind: "videoinput" | "audioinput") =>
    preferredDevice(kind)?.label ?? "Connected";
  const deviceStatus = (track: MediaStreamTrack | undefined, kind: "videoinput" | "audioinput") =>
    track
      ? { done: true, text: deviceName(track.label) || "Connected" }
      : nativePreview && cameraOn
        ? { done: true, text: nativeLabel(kind) }
        : cameraStatus === "error"
        ? { done: false, failed: true, text: "Not available" }
        : { done: false, text: "Waiting for access…" };
  const devices: {
    name: string;
    done: boolean;
    failed?: boolean;
    text: string;
    picker?: ReactNode;
    aside?: ReactNode;
  }[] = [
    ...(willRecord
      ? [
          {
            name: "Camera",
            ...deviceStatus(videoTrack, "videoinput"),
            // Past the system default, at least two to choose between.
            picker: (videoTrack || (nativePreview && cameraOn)) && !isPhone && available.cameras.length > 2 && (
              <DevicePicker
                label="Camera"
                value={chosenId("videoinput", available.cameras)}
                options={available.cameras}
                onChange={(choice) => onSwitchDevice("videoinput", choice)}
              />
            ),
          },
          {
            name: "Microphone",
            ...deviceStatus(audioTrack, "audioinput"),
            picker: (audioTrack || (nativePreview && cameraOn)) && available.mics.length > 2 && (
              <DevicePicker
                label="Microphone"
                value={chosenId("audioinput", available.mics)}
                options={available.mics}
                onChange={(choice) => onSwitchDevice("audioinput", choice)}
              />
            ),
            aside: nativePreview
              ? cameraOn && <NativeMicLevel />
              : cameraStream && audioTrack && checkAudio && (
                  <MicLevel stream={cameraStream} context={checkAudio} />
                ),
          },
        ]
      : []),
    {
      name: "Speakers",
      done: available.speakerFound,
      text: available.speakerFound ? speakerLabel : "No speaker detected",
      picker: canChooseSpeaker && available.speakers.length > 2 && (
        <DevicePicker
          label="Speakers"
          value={available.speakers.some((o) => o.id === speakerId) ? speakerId : ""}
          options={available.speakers}
          onChange={chooseSpeaker}
        />
      ),
      aside: (
        <button type="button" className="btn-secondary" onClick={testSpeakers}>
          {"Test"}
        </button>
      ),
    },
  ];

  // What Start is waiting on, said beside the button — never as its label.
  const linesStatus = directing
    ? "Directing the scene…"
    : allLinesReady
      ? "Your scene partners’ lines are ready."
      : `Preparing your scene partners’ lines${pregen.total > 0 ? ` · ${pregen.ready} of ${pregen.total}` : "…"}`;
  const blockedStatus = !willRecord
    ? null
    : cameraStatus === "error"
      ? "Recording needs your camera and microphone. Fix them above, or just run lines without recording."
      : !cameraOn
        ? "Waiting for your camera and microphone."
        : !scriptSaved
          ? "Saving your script to this device…"
          : null;
  const linesNote = allLinesReady
    ? null
    : pregen.failed > 0
      ? "Some lines couldn’t be pre-loaded; they’ll load as you go."
      : linesReady
        ? "The rest keep loading while you rehearse."
        : linesStartable
          ? "This is taking a while. You can start now; lines that aren’t ready load as you go."
          : "You can start once enough lines are ready.";

  return (
    <SetupStep
      step={4}
      scriptName={scriptName}
      onGoToStep={onGoToStep}
      intro={
        <>
          <h1 className="title">Get ready</h1>
          <p className="lead">
            {willRecord
              ? "We’ll record a self-tape while you run the scene — or run your lines first without recording. Check your framing while your scene partners get ready."
              : "Sit back and listen to the full scene while your scene partners get ready."}
          </p>
          {/* With the title on wide screens, so the checks and Start stay
              above the fold; in the one column on phones. */}
          {willRecord && (
            <div className="rehearsal-setup-camera">
              <div className={`self-tape-video ${nativePreview ? "is-native-preview" : ""}`}>
                {nativePreview && cameraOn ? (
                  <NativeCameraPreview className="self-tape-preview" />
                ) : cameraStream ? (
                  <video
                    className="self-tape-preview"
                    ref={previewRef}
                    muted
                    autoPlay
                    playsInline
                  />
                ) : (
                  <div className="self-tape-placeholder">
                    {cameraStatus === "error"
                      ? "Camera not available"
                      : "Waiting for camera access…"}
                  </div>
                )}
              </div>
              {cameraOn && isIpad() && (
                <p className="field-hint self-tape-hint">
                  Tip: turn off Center Stage in Control Center for steady framing.
                </p>
              )}
              {/* Only where the camera itself zooms: no digital crop. */}
              {cameraOn && cameraZoom && (
                <label className="range-row camera-zoom">
                  <span>Zoom</span>
                  <input
                    type="range"
                    className="range"
                    min={cameraZoom.range.min}
                    max={cameraZoom.range.max}
                    step={cameraZoom.range.step}
                    value={cameraZoom.value}
                    onChange={(event) => onZoom(Number(event.target.value))}
                  />
                  <output>{cameraZoom.value.toFixed(1)}×</output>
                </label>
              )}
            </div>
          )}
        </>
      }
    >

      <ul className="rehearsal-setup-devices" aria-label="Your devices">
        {devices.map((device) => (
          <li
            key={device.name}
            className={
              device.done
                ? "is-complete"
                : device.failed
                  ? "is-failed"
                  : undefined
            }
          >
            <span className="device-mark" aria-hidden="true">
              {device.done ? "✓" : device.failed ? "✕" : "○"}
            </span>
            <strong>{device.name}</strong>
            {device.picker || <small title={device.text}>{device.text}</small>}
            {device.aside}
          </li>
        ))}
      </ul>
      {willRecord && cameraStatus === "error" && (
        <div className="notice notice-danger device-problem" role="alert">
          <p>{cameraError}</p>
          <button
            type="button"
            className="btn-secondary"
            onClick={onRetryCamera}
          >
            Try again
          </button>
        </div>
      )}
      {willRecord && permissionSlow && (
        <div className="notice notice-warn device-problem" role="status">
          <p>
            Look for your browser’s permission prompt near the address bar and
            choose Allow for the camera and microphone.
          </p>
          <button
            type="button"
            className="btn-secondary"
            onClick={onRetryCamera}
          >
            Ask again
          </button>
        </div>
      )}

      {willRecord && !storageNoticeDismissed && (
        <div className="notice device-problem device-storage-notice" role="note">
          <p>
            <strong>Your takes stay on this device.</strong> Scripts and
            recordings are saved only in this {IS_NATIVE ? "app" : "browser"},
            not on our servers, so they won’t appear on your other devices
            and are lost if you clear {IS_NATIVE ? "the app’s" : "this site’s"} data.
            Download a take to keep it.
          </p>
          <button type="button" className="btn-ghost" onClick={dismissStorageNotice}>
            Got it
          </button>
        </div>
      )}

      <div className="setup-start-status">
        <div className="setup-start-meter" aria-hidden="true">
          <i
            style={{
              width: `${pregen.total ? (pregen.ready / pregen.total) * 100 : pregen.done ? 100 : 0}%`,
            }}
          />
        </div>
        <p id="setup-start-status" role="status">
          {linesStatus}
          {blockedStatus && <span>{blockedStatus}</span>}
        </p>
        {linesNote && <p className="setup-start-note">{linesNote}</p>}
      </div>
      <button
        type="button"
        className="btn-primary btn-lg btn-block setup-start"
        disabled={!canStart}
        aria-describedby="setup-start-status"
        onClick={onStart}
      >
        {linesReady || !canStart ? "Start rehearsal" : "Start without waiting"}
      </button>
      {/* Back, and a run without the tape, under the start button. */}
      <div className="rehearsal-setup-actions">
        <button type="button" className="btn-ghost" onClick={onBack}>
          Back
        </button>
        {onPracticeRun && (
          <button
            type="button"
            className="btn-secondary"
            // Needs only the lines: no tape, so no camera to wait for.
            disabled={!linesStartable}
            onClick={onPracticeRun}
          >
            Just run lines
          </button>
        )}
      </div>
    </SetupStep>
  );
}
