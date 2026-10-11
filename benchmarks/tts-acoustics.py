#!/usr/bin/env python3
"""Acoustic proxies for the emotiveness benchmark (benchmarks/tts-emotion.ts).

A flat, "robotic" read has little pitch movement and little variation in
loudness and pace. This measures those per rendered clip and compares each
configuration against the baseline, so settings can be screened cheaply
before anyone listens. They are proxies: validate them once against the
blind listening scores (see benchmarks/README.md) before trusting them alone.

Per clip:
  f0_median_hz    median voiced pitch
  f0_std_st       pitch standard deviation, in semitones around the median
  f0_range_st     5th–95th percentile pitch range, in semitones
  voiced_share    share of frames with a detected pitch
  rms_std_db      loudness variation (std of frame RMS, dB)
  pauses          silent stretches ≥ 150 ms inside the clip
  pause_share     share of the clip that is silence
  rate_std        variation in syllable-rate proxy (energy peaks/s per 0.5 s)
  duration_s

Usage:
  python3 benchmarks/tts-acoustics.py benchmarks/out/tts-emotion/<run>
  python3 benchmarks/tts-acoustics.py benchmarks/out/tts-emotion/<run> --csv

Needs: pip install -r benchmarks/requirements-acoustics.txt
(librosa, numpy, soundfile; soundfile ≥ 0.12 decodes MP3 without ffmpeg).
"""

import csv
import json
import sys
from pathlib import Path
from statistics import mean

try:
    import librosa
    import numpy as np
except ImportError as error:  # pragma: no cover
    sys.exit(f"{error}. Install with: pip install -r benchmarks/requirements-acoustics.txt")

SR = 22050
FRAME = 1024
HOP = 256
SILENCE_DB = -40
MIN_PAUSE_S = 0.15


def hz_to_semitones(f0, reference):
    return 12 * np.log2(f0 / reference)


def analyze(path: Path) -> dict:
    y, sr = librosa.load(path, sr=SR, mono=True)
    duration = len(y) / sr
    f0, voiced, _ = librosa.pyin(
        y, fmin=librosa.note_to_hz("C2"), fmax=librosa.note_to_hz("C6"),
        sr=sr, frame_length=FRAME * 2, hop_length=HOP,
    )
    f0v = f0[voiced & ~np.isnan(f0)] if f0 is not None else np.array([])
    if f0v.size > 4:
        median = float(np.median(f0v))
        st = hz_to_semitones(f0v, median)
        f0_std_st = float(np.std(st))
        f0_range_st = float(np.percentile(st, 95) - np.percentile(st, 5))
    else:
        median, f0_std_st, f0_range_st = float("nan"), float("nan"), float("nan")

    rms = librosa.feature.rms(y=y, frame_length=FRAME, hop_length=HOP)[0]
    rms_db = librosa.amplitude_to_db(rms + 1e-9, ref=np.max)
    speaking = rms_db > SILENCE_DB
    rms_std_db = float(np.std(rms_db[speaking])) if speaking.any() else float("nan")

    # Pauses: runs of silence inside the clip (leading/trailing silence trimmed).
    frames_per_s = sr / HOP
    idx = np.where(speaking)[0]
    pauses, pause_frames = 0, 0
    if idx.size:
        inner = speaking[idx[0]: idx[-1] + 1]
        run = 0
        for frame in inner:
            if not frame:
                run += 1
            else:
                if run >= MIN_PAUSE_S * frames_per_s:
                    pauses += 1
                    pause_frames += run
                run = 0
    pause_share = pause_frames / max(1, len(speaking))

    # Syllable-rate proxy: energy peaks per second, measured over 0.5 s windows.
    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP)
    peaks = librosa.util.peak_pick(onset_env, pre_max=3, post_max=3, pre_avg=3, post_avg=5, delta=0.5, wait=5)
    window = int(0.5 * frames_per_s)
    rates = [
        np.sum((peaks >= start) & (peaks < start + window)) / 0.5
        for start in range(0, max(1, len(onset_env) - window), window)
    ]
    rate_std = float(np.std(rates)) if len(rates) > 1 else float("nan")

    return {
        "duration_s": round(duration, 2),
        "f0_median_hz": round(median, 1),
        "f0_std_st": round(f0_std_st, 2),
        "f0_range_st": round(f0_range_st, 2),
        "voiced_share": round(float(np.mean(voiced)) if voiced is not None and voiced.size else float("nan"), 3),
        "rms_std_db": round(rms_std_db, 2),
        "pauses": pauses,
        "pause_share": round(pause_share, 3),
        "rate_std": round(rate_std, 2),
    }


METRICS = ["f0_std_st", "f0_range_st", "rms_std_db", "pauses", "pause_share", "rate_std", "duration_s"]


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    run_dir = Path(sys.argv[1])
    key = json.loads((run_dir / "key.json").read_text())
    rows = []
    for render in key["renders"]:
        path = run_dir / render["file"]
        if not path.exists():
            continue
        metrics = analyze(path)
        rows.append({"line": render["line"], "config": render["config"], "file": render["file"], **metrics})
        print(f"{render['config']:>14} {render['line']:<22} f0σ {metrics['f0_std_st']:>5} st  range {metrics['f0_range_st']:>5} st  rmsσ {metrics['rms_std_db']:>5} dB  pauses {metrics['pauses']}")

    if "--csv" in sys.argv or True:
        out = run_dir / "acoustics.csv"
        with out.open("w", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=["line", "config", "file", *METRICS, "f0_median_hz", "voiced_share"])
            writer.writeheader()
            writer.writerows(rows)
        print(f"\nWrote {out}")

    configs = sorted({row["config"] for row in rows})
    baseline = key.get("pairWith", "baseline")
    print("\nMeans per config (Δ vs %s):" % baseline)
    print(f"{'config':>14} " + " ".join(f"{metric:>13}" for metric in METRICS))
    base = {}
    if baseline in configs:
        base = {m: mean(r[m] for r in rows if r["config"] == baseline and r[m] == r[m]) for m in METRICS}
    for config in configs:
        cells = []
        for metric in METRICS:
            values = [r[metric] for r in rows if r["config"] == config and r[metric] == r[metric]]
            if not values:
                cells.append(f"{'—':>13}")
                continue
            value = mean(values)
            delta = f"{value - base[metric]:+.2f}" if base and config != baseline else ""
            cells.append(f"{value:6.2f} {delta:>6}")
        print(f"{config:>14} " + " ".join(cells))
    print("\nHigher f0_std_st / f0_range_st / rms_std_db = more vocal movement; read with the listening scores, not instead of them.")


if __name__ == "__main__":
    main()
