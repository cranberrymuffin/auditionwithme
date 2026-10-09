// Checks for adjusting the scene partner's volume after a take (beta
// request: reader volume should be set on the self-tape, not mid-take).
// Exercises the pure decisions in src/lib/tapeRemix.ts — stem alignment,
// drift correction, volume clamping, download path, recorder formats — that
// useSelfTapeRecorder.ts, stemMixer.ts and useTapeRemix.ts rely on, with no
// DOM, Web Audio, or network.
//
//   npm run test:remix
//
// Run with tsx (no test runner in this repo; failures exit non-zero).

import assert from "node:assert/strict";
import {
  alignStem,
  chooseDownloadPath,
  clampReaderVolume,
  exportDuration,
  formatClock,
  isUnityVolume,
  measureDrift,
  pickSupportedType,
  remixMimeCandidates,
  shouldPlayStems,
  shouldResync,
  stemMimeCandidates,
} from "../src/lib/tapeRemix";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

const close = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

check("volume clamps to 0–2 and junk reads as 100%", () => {
  assert.equal(clampReaderVolume(-1), 0);
  assert.equal(clampReaderVolume(5), 2);
  assert.equal(clampReaderVolume(1.5), 1.5);
  assert.equal(clampReaderVolume(undefined), 1);
  assert.equal(clampReaderVolume(NaN), 1);
  assert.equal(clampReaderVolume(Infinity), 1);
  assert.equal(clampReaderVolume("1.5"), 1);
});

check("float noise around 100% snaps to exactly unity", () => {
  assert.equal(clampReaderVolume(0.1 + 0.9000000001), 1);
  assert.equal(clampReaderVolume(1.004), 1);
  assert.ok(isUnityVolume(1));
  assert.ok(!isUnityVolume(1.05));
  assert.ok(!isUnityVolume(0.95));
});

check("100% (or no stems) downloads the original instantly", () => {
  assert.equal(chooseDownloadPath(true, 1), "original");
  assert.equal(chooseDownloadPath(false, 1), "original");
  assert.equal(chooseDownloadPath(false, 1.6), "original");
  assert.equal(chooseDownloadPath(true, 1.6), "remix");
  assert.equal(chooseDownloadPath(true, 0), "remix");
});

check("stems only take over playback off 100%", () => {
  assert.equal(shouldPlayStems(true, 1), false);
  assert.equal(shouldPlayStems(true, 0.5), true);
  assert.equal(shouldPlayStems(false, 0.5), false);
});

check("a stem that started late waits for the video to reach it", () => {
  // Stem recorder started 120ms after the main one.
  const at = alignStem(0, 120, 30);
  assert.ok(at);
  close(at.offset, 0);
  close(at.delay, 0.12);
});

check("a stem that started late is behind the video by its offset", () => {
  const at = alignStem(10, 120, 30);
  assert.ok(at);
  close(at.offset, 9.88);
  close(at.delay, 0);
});

check("a stem that started early is ahead of the video", () => {
  const at = alignStem(2, -50, 30);
  assert.ok(at);
  close(at.offset, 2.05);
  close(at.delay, 0);
});

check("past a stem's end there is nothing to play", () => {
  assert.equal(alignStem(31, 0, 30), null);
  assert.equal(alignStem(30, 0, 30), null);
  assert.ok(alignStem(29.9, 0, 30));
});

check("drift is the video's lead over the stems' own clock", () => {
  // Anchored at video 5s / clock 100s; 2s of clock at 1x expects video 7s.
  close(measureDrift(7, 5, 100, 102, 1), 0);
  close(measureDrift(7.05, 5, 100, 102, 1), 0.05);
  close(measureDrift(6.97, 5, 100, 102, 1), -0.03);
  // At 1.5x, 2s of clock covers 3s of video.
  close(measureDrift(8, 5, 100, 102, 1.5), 0);
});

check("re-seek only past ~40ms of drift, and not twice within a second", () => {
  assert.equal(shouldResync(0.03, 5), false);
  assert.equal(shouldResync(-0.039, 5), false);
  assert.equal(shouldResync(0.05, 5), true);
  assert.equal(shouldResync(-0.05, 5), true);
  assert.equal(shouldResync(0.5, 0.2), false);
  assert.equal(shouldResync(0.5, 1), true);
});

check("stems use the main recording's container family", () => {
  const safari = (type: string) => type.startsWith("audio/mp4") || type.startsWith("video/mp4");
  const chrome = (type: string) => type.includes("webm");
  assert.equal(
    pickSupportedType(stemMimeCandidates("video/mp4;codecs=avc1,mp4a"), safari),
    "audio/mp4;codecs=mp4a.40.2",
  );
  assert.equal(pickSupportedType(stemMimeCandidates(""), chrome), "audio/webm;codecs=opus");
  assert.equal(pickSupportedType(stemMimeCandidates("video/webm"), chrome), "audio/webm;codecs=opus");
  // A browser that records mp4 video but would also take webm still gets mp4.
  assert.equal(
    pickSupportedType(stemMimeCandidates("video/mp4"), () => true),
    "audio/mp4;codecs=mp4a.40.2",
  );
  assert.equal(pickSupportedType(stemMimeCandidates("video/mp4"), () => false), undefined);
});

check("a remixed tape keeps the original's container family", () => {
  assert.ok(remixMimeCandidates("video/mp4").every((type) => type.startsWith("video/mp4")));
  assert.ok(remixMimeCandidates("video/webm;codecs=vp8,opus").every((type) => type.startsWith("video/webm")));
  assert.ok(remixMimeCandidates("").every((type) => type.startsWith("video/webm")));
});

check("export length falls back to the stems when the video has none", () => {
  assert.equal(exportDuration(42.5, []), 42.5);
  close(exportDuration(Infinity, [{ duration: 30, offsetMs: 100 }, { duration: 29, offsetMs: 0 }]), 30.1);
  close(exportDuration(NaN, [{ duration: 12, offsetMs: -20 }]), 11.98);
  assert.equal(exportDuration(Infinity, []), 0);
});

check("progress clock reads m:ss", () => {
  assert.equal(formatClock(0), "0:00");
  assert.equal(formatClock(65.9), "1:05");
  assert.equal(formatClock(600), "10:00");
  assert.equal(formatClock(Infinity), "0:00");
  assert.equal(formatClock(-3), "0:00");
});

console.log(`\n${passed} checks passed`);
