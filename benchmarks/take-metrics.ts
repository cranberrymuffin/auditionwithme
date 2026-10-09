// Checks for the per-take telemetry saved on self_tape_feedback rows
// (src/lib/takeMetrics.ts): p50/max over reader-latency samples, how line
// advances are counted, and that a latency sample only ever pairs an actor
// line with the step right after it. Pure logic, no browser or network.
//
//   npm run test:metrics
//
// Run with tsx (no test runner in this repo; failures exit non-zero).

import assert from "node:assert/strict";
import { computeMax, computeP50, TakeMetrics } from "../src/lib/takeMetrics";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

const noDevice = { deviceClass: null, videoWidth: null, videoHeight: null };

check("p50/max are null with no samples", () => {
  assert.equal(computeP50([]), null);
  assert.equal(computeMax([]), null);
});

check("p50 of an odd count is the middle sample, regardless of order", () => {
  assert.equal(computeP50([900, 300, 600]), 600);
  assert.equal(computeP50([450]), 450);
});

check("p50 of an even count averages the middle two, rounded", () => {
  assert.equal(computeP50([400, 100, 300, 200]), 250);
  assert.equal(computeP50([100, 201]), 151);
});

check("p50 does not reorder the caller's array", () => {
  const samples = [3, 1, 2];
  computeP50(samples);
  assert.deepEqual(samples, [3, 1, 2]);
});

check("max is the largest sample, rounded", () => {
  assert.equal(computeMax([120, 1840.6, 700]), 1841);
});

check("detected lines open a latency sample that the next step closes", () => {
  const m = new TakeMetrics();
  m.recordLineCompleted("auto", 1_000);
  const start = m.takePendingAdvance();
  assert.equal(start, 1_000);
  m.recordReaderLatency(1_650 - start!);
  // Taken once: a later step can't measure from the same line.
  assert.equal(m.takePendingAdvance(), null);
  assert.deepEqual(m.readerLatencies, [650]);
});

check("a manual Next counts but opens no latency sample", () => {
  const m = new TakeMetrics();
  m.recordLineCompleted("auto", 1_000);
  m.recordManualNext(); // supersedes any stale start
  assert.equal(m.takePendingAdvance(), null);
  assert.equal(m.linesManualNext, 1);
});

check("negative or non-finite latencies are dropped", () => {
  const m = new TakeMetrics();
  m.recordReaderLatency(-5);
  m.recordReaderLatency(Number.NaN);
  m.recordReaderLatency(Number.POSITIVE_INFINITY);
  assert.deepEqual(m.readerLatencies, []);
});

check("a whole take aggregates into the feedback row", () => {
  const m = new TakeMetrics();
  // Line 1: word match, reader plays 700ms later.
  m.recordLineCompleted("auto", 10_000);
  m.recordReaderLatency(10_700 - m.takePendingAdvance()!);
  // Line 2: semantic fallback, reader plays 1300ms later.
  m.recordLineCompleted("semantic", 20_000);
  m.recordReaderLatency(21_300 - m.takePendingAdvance()!);
  // Line 3: stalled, actor pressed Next.
  m.recordManualNext();
  assert.equal(m.takePendingAdvance(), null);
  // Line 4: word match, reader plays 900ms later.
  m.recordLineCompleted("auto", 30_000);
  m.recordReaderLatency(30_900 - m.takePendingAdvance()!);

  assert.deepEqual(m.toRow({ deviceClass: "tablet", videoWidth: 1920, videoHeight: 1080 }), {
    reader_latency_ms_p50: 900,
    reader_latency_ms_max: 1300,
    lines_auto_detected: 2,
    lines_manual_next: 1,
    lines_semantic_advanced: 1,
    lines_silence_advanced: 0,
    pregen_ms: null,
    pregen_failed_lines: null,
    live_fetches_during_take: null,
    device_class: "tablet",
    video_width: 1920,
    video_height: 1080,
  });
});

check("silence advances are counted apart from semantic ones", () => {
  const m = new TakeMetrics();
  m.recordLineCompleted("silence", 1);
  const row = m.toRow(noDevice);
  assert.equal(row.lines_silence_advanced, 1);
  assert.equal(row.lines_semantic_advanced, 0);
});

check("live fetches stay null until counted, then count up from 0", () => {
  const m = new TakeMetrics();
  assert.equal(m.toRow(noDevice).live_fetches_during_take, null);
  m.liveFetchesDuringTake = 0;
  assert.equal(m.toRow(noDevice).live_fetches_during_take, 0);
  m.recordLiveFetch();
  m.recordLiveFetch();
  assert.equal(m.toRow(noDevice).live_fetches_during_take, 2);
  // A take that never zeroed the counter still reports what it saw.
  const unzeroed = new TakeMetrics();
  unzeroed.recordLiveFetch();
  assert.equal(unzeroed.toRow(noDevice).live_fetches_during_take, 1);
});

check("the row is numeric only (plus device class)", () => {
  const m = new TakeMetrics();
  m.recordLineCompleted("auto", 0);
  m.recordReaderLatency(500);
  const row = m.toRow({ deviceClass: "phone", videoWidth: 1280.4, videoHeight: Number.NaN });
  for (const [key, value] of Object.entries(row)) {
    if (key === "device_class") assert.equal(value, "phone");
    else assert.ok(value === null || Number.isInteger(value), `${key} = ${String(value)}`);
  }
  assert.equal(row.video_width, 1280);
  assert.equal(row.video_height, null);
});

console.log(`\n${passed} checks passed`);
