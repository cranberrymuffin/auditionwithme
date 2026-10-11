# Benchmarks and checks

Scripts that exercise the app's pure logic and its AI pipeline outside the
browser. There's no test runner in this repo: each check is a `tsx` script
that asserts and exits non-zero on failure, and each benchmark is a script
that calls the real services and writes its output under `benchmarks/out/`
(gitignored).

| Folder | What's in it | Costs money? |
| --- | --- | --- |
| `checks/` | Assertions on pure logic (`npm run test:*`) | No |
| `parse/` | Script parsing: PDF upload latency, sides-parse comparison | Anthropic |
| `voice/` | The scene partner's voice: emotiveness benchmark, tone A/B | Anthropic + ElevenLabs |

## Checks

```sh
npm run test:match        # live line matching (checks/line-match.ts)
npm run test:cutoff       # end-of-line cut-off guard (checks/cutoff-guard.ts)
npm run test:metrics      # per-take rehearsal metrics (checks/take-metrics.ts)
npm run test:parse-cache  # saving a parse as it arrives (checks/parse-cache.ts)
npm run test:pregen       # reader-audio cache keys and pre-generation scheduling (checks/pregen.ts)
npm run test:emotion      # emotiveness harness checks and plan, no API calls (voice/emotion.ts --dry-run)
```

Run them all before a PR; CI doesn't yet.

## Parsing

**Sides parse comparison** (`parse/sides-parse.ts`, `npm run bench:sides`):
runs the deterministic screenplay-layout parser over the PDFs in
`test_data/` and reports what each strategy extracts.

**PDF upload latency** (`parse/pdf-latency.mjs`, `npm run benchmark:pdf`):
compares the original binary-PDF model request with the text-first request.

```sh
cupsfilter -m application/pdf benchmarks/parse/fixture-script.txt > /tmp/audition-benchmark.pdf
npm run benchmark:pdf -- /tmp/audition-benchmark.pdf
# end to end, two local servers with the same ANTHROPIC_API_KEY:
BASELINE_URL=http://127.0.0.1:5174/api/parse-script \
OPTIMIZED_URL=http://127.0.0.1:5173/api/parse-script \
BENCHMARK_ROUNDS=6 npm run benchmark:pdf -- /tmp/audition-benchmark.pdf
```

Measured July 25, 2026 on the two-page, 29-line fixture (one model request
per variant, so normal API variance applies):

| Measurement | Before | After | Change |
| --- | ---: | ---: | ---: |
| End-to-end processing | 22,008 ms | 15,840 ms | 28.0% faster |
| Request body | 25,498 bytes | 1,763 bytes | 93.1% smaller |
| API response | 5,794 bytes | 4,327 bytes | 25.3% smaller |
| Extracted dialogue steps | 29 | 29 | No change |

Client-side text extraction took 24.9 ms median and 259.8 ms p95 across six
runs. Text-layer PDFs are extracted in the browser and sent as text;
scanned, encrypted or extraction-failing PDFs keep the document-model
fallback, and the model no longer echoes a duplicate full-script field.

## Voice

### Emotiveness benchmark (`voice/emotion.ts`)

Beta feedback says the AI scene partner "sounds robotic". The previous round
said it was "over the top", and the fix for that (the reader-first director
prompt, v3 stability 0.3, most lines left untagged) overshot. This benchmark
measures both failure modes at once, so a new default is judged on
naturalness, emotional fit *and* restraint rather than swinging between them.

**Fixture** `test_data/tts-emotion-lines.json`: ten scenes excerpted from the
sides in `test_data/`, 86 target lines, each with a hand-written label
(emotion, family, intensity, where the script cues it, whether it's a
reply). The mix leans low-intensity on purpose: a flat read is most audible
on quiet, ordinary lines, and an over-played one shows on the same lines.
`--quick` is a ~30-line subset.

**Configs** `voice/emotion-configs.ts`: `baseline` is production today; every
other config changes one thing (model, stability, style, prompt, context,
emotion). Put the winners into `candidate` once each has beaten the baseline
on its own. `--list` prints them.

```sh
npm run test:emotion                                        # checks + plan, no API calls
npm run bench:emotion -- --direct-only --config baseline --config warm-prompt
                                                            # director + markup audit only (Anthropic only)
npm run bench:emotion -- --quick --config v4 --config warm-prompt --run quick-1
npm run bench:emotion -- --config v4 --config stab-0.45 --run full-1
```

Each run writes `benchmarks/out/tts-emotion/<run>/`: the audio, `key.json`
(every render's markup, settings, voice and billed characters), `audit.json`,
and the blind `rater.html`. Renders run one at a time so live rehearsals keep
the ElevenLabs account's concurrency; `key.json` totals what the run billed.

Three tiers of measurement, cheapest first:

1. **Markup audit** (printed after every run; `--direct-only` needs no
   audio): share of lines directed, share of *cued* lines left with no
   shaping at all (the flat-read risk), how often the director's tag family
   matches the label, whether neutral lines were over-tagged.
2. **Acoustic proxies** (`voice/acoustics.py`): pitch, loudness, pause and
   pace variation per clip, with means per config against the baseline.
   ```sh
   pip install -r benchmarks/voice/requirements.txt
   python3 benchmarks/voice/acoustics.py benchmarks/out/tts-emotion/<run>
   ```
   Validate these once against listening scores before using them to screen
   settings on their own.
3. **Listening.** Human: open `rater.html`, answer the three questions per
   pair (sounds like a real reader / fits the moment / over the top),
   download the ratings JSON. AI: `GEMINI_API_KEY=… npm run bench:emotion --
   --ai-rate --run <run>` has Gemini answer the same questions from the
   audio, hearing each pair in both orders and counting only answers the
   orders agree on (`--ai-model`, `--pairs N`). Score either kind:
   ```sh
   npm run bench:emotion -- --score ratings-*.json --run <run>
   npm run bench:emotion -- --agreement ratings-<human>.json ratings-ai-*.json --run <run>
   ```
   `--score` prints win rates with 95% intervals per config against the
   baseline; `--agreement` prints percent agreement and Cohen's kappa
   between two raters. Below about 0.4 kappa with a human, don't let the AI
   rater decide anything on its own.

**Ship criteria** for a new default: naturalness win rate ≥ 65% with the
interval's low end above 50%, emotional fit not worse, "over the top" not
above the baseline. Then bump `DIRECTOR_VERSION` if the prompt changed, bump
the reader-audio cache key (model and stability aren't in it today), and
watch the share of feedback comments mentioning robotic/flat for two weeks.

The `dialogue` config renders whole scenes through Text-to-Dialogue, so it
produces scene clips rather than per-line pairs; rate those on their own in
the rater page's "Scene clips" section.

### Tone A/B (`voice/tone-ab.ts`)

The earlier, narrower harness from the "over the top" round: six synthetic
lines (`test_data/tts-tone-lines.json`) rendered under the old "skilled
actor" prompt at Creative stability and under the current reader-first
prompt at 0.3, as blind A/B pairs. Kept for reference; the emotiveness
benchmark supersedes it.

```sh
npx tsx benchmarks/voice/tone-ab.ts --dry-run
npx tsx benchmarks/voice/tone-ab.ts
```
