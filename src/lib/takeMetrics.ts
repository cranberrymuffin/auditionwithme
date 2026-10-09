// Per-take rehearsal telemetry, saved on the audition's self_tape_feedback
// row (see supabase/migrations/20261008120000_self_tape_feedback_metrics.sql).
// Numeric only: nothing here ever holds a transcript, script text, or audio.
// No imports, so benchmarks/take-metrics.ts can run it under plain tsx.

/** How the actor's line got credited as finished without a manual Next. */
export type DetectedAdvanceKind = "auto" | "semantic" | "silence";

/** The moment (client Date.now()) a line was credited as finished, and how. */
export type LineCompletion = { kind: DetectedAdvanceKind; at: number };

export type DeviceClass = "phone" | "tablet" | "desktop";

/** One take's metrics, keyed by self_tape_feedback column name. */
export type TakeMetricsRow = {
  reader_latency_ms_p50: number | null;
  reader_latency_ms_max: number | null;
  lines_auto_detected: number;
  lines_manual_next: number;
  lines_semantic_advanced: number;
  lines_silence_advanced: number;
  pregen_ms: number | null;
  pregen_failed_lines: number | null;
  live_fetches_during_take: number | null;
  device_class: DeviceClass | null;
  video_width: number | null;
  video_height: number | null;
};

/** Median, rounded to whole ms; null when there are no samples. */
export function computeP50(latencies: number[]): number | null {
  if (latencies.length === 0) return null;
  const sorted = [...latencies].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(median);
}

export function computeMax(latencies: number[]): number | null {
  if (latencies.length === 0) return null;
  return Math.round(Math.max(...latencies));
}

export function deviceClass(): DeviceClass | null {
  if (typeof navigator === "undefined" || typeof screen === "undefined") return null;
  if (navigator.maxTouchPoints > 0) {
    return Math.min(screen.width, screen.height) >= 600 ? "tablet" : "phone";
  }
  return "desktop";
}

/**
 * Accumulates one take's metrics. Reader latency starts at the client time
 * of the Scribe message (or semantic/silence trigger) that completed the
 * actor's line and ends at the 'playing' event of the next reader line, so it
 * excludes Scribe's own transcription lag — a known undercount. Lines the
 * actor advanced by hand aren't sampled: there's no detection moment to
 * measure from, and the press itself isn't the actor finishing their line.
 */
export class TakeMetrics {
  readonly readerLatencies: number[] = [];
  linesAutoDetected = 0;
  linesManualNext = 0;
  linesSemanticAdvanced = 0;
  linesSilenceAdvanced = 0;
  // Copied from reader-audio pre-generation (useReaderAudioPregen) when the
  // take ends. null = unmeasured, never a stand-in 0.
  pregenMs: number | null = null;
  pregenFailedLines: number | null = null;
  // TTS fetches the take had to make, or wait on, because pre-generation
  // hadn't reached the line yet. null until a take starts counting (0).
  liveFetchesDuringTake: number | null = null;
  private pendingAdvanceAt: number | null = null;

  /** The actor's line was credited as finished at `at`; the next reader
   * line's 'playing' event closes the latency sample opened here. */
  recordLineCompleted(kind: DetectedAdvanceKind, at: number) {
    if (kind === "auto") this.linesAutoDetected += 1;
    else if (kind === "semantic") this.linesSemanticAdvanced += 1;
    else this.linesSilenceAdvanced += 1;
    this.pendingAdvanceAt = at;
  }

  recordLiveFetch() {
    this.liveFetchesDuringTake = (this.liveFetchesDuringTake ?? 0) + 1;
  }

  recordManualNext() {
    this.linesManualNext += 1;
    this.pendingAdvanceAt = null;
  }

  /** Hands back (and clears) the open latency start, if any. Called as each
   * step's playback begins, so a sample only ever pairs an actor line with
   * the step immediately after it. */
  takePendingAdvance(): number | null {
    const at = this.pendingAdvanceAt;
    this.pendingAdvanceAt = null;
    return at;
  }

  recordReaderLatency(ms: number) {
    if (Number.isFinite(ms) && ms >= 0) this.readerLatencies.push(ms);
  }

  toRow(device: {
    deviceClass: DeviceClass | null;
    videoWidth: number | null;
    videoHeight: number | null;
  }): TakeMetricsRow {
    const dimension = (value: number | null) =>
      value !== null && Number.isFinite(value) ? Math.round(value) : null;
    return {
      reader_latency_ms_p50: computeP50(this.readerLatencies),
      reader_latency_ms_max: computeMax(this.readerLatencies),
      lines_auto_detected: this.linesAutoDetected,
      lines_manual_next: this.linesManualNext,
      lines_semantic_advanced: this.linesSemanticAdvanced,
      lines_silence_advanced: this.linesSilenceAdvanced,
      pregen_ms: this.pregenMs,
      pregen_failed_lines: this.pregenFailedLines,
      live_fetches_during_take: this.liveFetchesDuringTake,
      device_class: device.deviceClass,
      video_width: dimension(device.videoWidth),
      video_height: dimension(device.videoHeight),
    };
  }
}
