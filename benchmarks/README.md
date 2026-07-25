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
