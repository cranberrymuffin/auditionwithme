# PDF upload latency benchmark

This benchmark compares the original binary-PDF model request with the
text-first request using the same PDF and model configuration.

## Reproduce preprocessing measurements

Create a PDF from the included fixture (macOS):

```sh
cupsfilter -m application/pdf benchmarks/fixture-script.txt > /tmp/audition-benchmark.pdf
npm run benchmark:pdf -- /tmp/audition-benchmark.pdf
```

To include end-to-end model processing, run merged `main` and this branch on
separate local ports with the same `ANTHROPIC_API_KEY`, then provide both API
URLs:

```sh
BASELINE_URL=http://127.0.0.1:5174/api/parse-script \
OPTIMIZED_URL=http://127.0.0.1:5173/api/parse-script \
BENCHMARK_ROUNDS=6 \
npm run benchmark:pdf -- /tmp/audition-benchmark.pdf
```

## Measured result

Measured July 25, 2026 on the included two-page, 29-line fixture. End-to-end
figures are one model request per variant, so normal API variance applies.

| Measurement | Before | After | Change |
| --- | ---: | ---: | ---: |
| End-to-end processing | 22,008 ms | 15,840 ms | 28.0% faster |
| Request body | 25,498 bytes | 1,763 bytes | 93.1% smaller |
| API response | 5,794 bytes | 4,327 bytes | 25.3% smaller |
| Extracted dialogue steps | 29 | 29 | No change |

Client-side text extraction took 24.9 ms median and 259.8 ms p95 across six
runs. The optimized model call itself took 15,408 ms.

The result comes from two changes:

1. Text-layer PDFs are extracted in the browser and sent as text. Scanned,
   image-only, encrypted, or extraction-failing PDFs retain the original
   document-model fallback.
2. The model no longer returns a duplicate full-script field when every line
   is already represented in the structured steps.

# Scene partner emotiveness benchmark

Beta feedback says the AI scene partner "sounds robotic". The previous
round of feedback said it was "over the top", and the fix for that (the
reader-first director prompt, v3 stability 0.3, most lines left untagged)
overshot. `tts-emotion.ts` measures both failure modes at once, so the next
change can be judged on naturalness, emotional fit *and* restraint rather
than swinging between them.

## What it renders

`test_data/tts-emotion-lines.json`: ten scenes excerpted from the sides in
`test_data/`, ~90 target lines, each with a hand-written label (emotion,
family, intensity, where the script cues it, whether it's a reply). The mix
leans low-intensity on purpose: a flat read is most audible on quiet,
ordinary lines, and an over-played one shows on the same lines. `--quick` is
a ~30-line subset.

`tts-emotion-configs.ts`: `baseline` is production today; every other config
changes one thing (model, stability, style, prompt, context, emotion). Add
the winners to `candidate` once each has beaten the baseline on its own.

## Procedure

```sh
npm run test:emotion                                    # checks + plan, no API calls
npm run bench:emotion -- --direct-only --config baseline --config warm-prompt
                                                        # director + markup audit only (Anthropic only)
npm run bench:emotion -- --quick --config v4 --run v4-quick
npm run bench:emotion -- --config v4 --config stab-0.45 --config warm-prompt --run week1
```

Each run writes `benchmarks/out/tts-emotion/<run>/` with the audio, `key.json`
(every render's markup, settings and voice), `audit.json`, and a blind
`rater.html`. Costs: one Anthropic call per scene per prompt variant, one
ElevenLabs render per line per config, run one at a time so live rehearsals
keep their concurrency.

Three tiers of measurement, cheapest first:

1. **Markup audit** (`audit.json`, printed after every run): share of lines
   directed, share of *cued* lines left with no shaping at all (the flat-read
   risk), how often the director's tag family matches the label, and whether
   neutral lines were over-tagged. No audio needed: `--direct-only`.
2. **Acoustic proxies**: `pip install -r benchmarks/requirements-acoustics.txt`,
   then `python3 benchmarks/tts-acoustics.py benchmarks/out/tts-emotion/<run>`.
   Pitch and loudness variation, pauses and pace variation per clip, with
   means per config against the baseline. Validate these once against the
   listening scores before using them to screen settings on their own.
3. **Blind listening**: open `rater.html`, rate each pair (sounds like a real
   reader / fits the moment / over the top), download the ratings JSON, then
   `npm run bench:emotion -- --score ratings-*.json --run <run>` prints win
   rates with 95% intervals per config against the baseline. Three to five
   raters, at least one an actor.

**Ship criteria** for a new default: naturalness win rate ≥ 65% with the
interval's low end above 50%, emotional fit not worse, "over the top" not
above the baseline. Then bump `DIRECTOR_VERSION` if the prompt changed, bump
the reader-audio cache key (model and stability aren't in it today), and
watch the share of feedback comments mentioning robotic/flat for two weeks.

The `dialogue` config renders whole scenes through Text-to-Dialogue, so it
produces scene clips rather than per-line pairs; rate those on their own in
the "Scene clips" section of the rater page.
