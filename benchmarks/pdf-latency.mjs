import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const pdfPath = process.argv[2];
const baselineUrl = process.env.BASELINE_URL;
const optimizedUrl = process.env.OPTIMIZED_URL;
const rounds = Number(process.env.BENCHMARK_ROUNDS ?? 5);

if (!pdfPath) {
  console.error("Usage: npm run benchmark:pdf -- path/to/script.pdf");
  process.exit(1);
}

const pdf = await readFile(pdfPath);

async function extractText() {
  const document = await getDocument({ data: new Uint8Array(pdf) }).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    let pageText = "";
    for (const item of content.items) {
      if (!("str" in item)) continue;
      pageText += item.str;
      pageText += item.hasEOL ? "\n" : " ";
    }
    pages.push(pageText.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim());
  }
  return pages.join("\n\n--- PAGE BREAK ---\n\n");
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

const extractionTimes = [];
let scriptText = "";
for (let index = 0; index < rounds; index += 1) {
  const startedAt = performance.now();
  scriptText = await extractText();
  extractionTimes.push(performance.now() - startedAt);
}

const pdfPayload = JSON.stringify({ pdfData: pdf.toString("base64") });
const textPayload = JSON.stringify({ scriptText });
const report = {
  fixture: {
    pdfBytes: pdf.byteLength,
    extractedCharacters: scriptText.length,
  },
  preprocessing: {
    rounds,
    extractionMedianMs: Number(percentile(extractionTimes, 0.5).toFixed(1)),
    extractionP95Ms: Number(percentile(extractionTimes, 0.95).toFixed(1)),
    baselineRequestBytes: Buffer.byteLength(pdfPayload),
    optimizedRequestBytes: Buffer.byteLength(textPayload),
    requestReductionPercent: Number(
      ((1 - Buffer.byteLength(textPayload) / Buffer.byteLength(pdfPayload)) * 100).toFixed(1),
    ),
  },
};

async function measureRequest(label, url, body) {
  const startedAt = performance.now();
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const responseBody = await response.text();
  const durationMs = performance.now() - startedAt;
  if (!response.ok) throw new Error(`${label} failed (${response.status}): ${responseBody}`);
  const parsed = JSON.parse(responseBody);
  return {
    durationMs: Number(durationMs.toFixed(1)),
    modelDurationMs: parsed.modelDurationMs,
    responseBytes: Buffer.byteLength(responseBody),
    stepCount: parsed.steps?.length ?? 0,
  };
}

if (baselineUrl && optimizedUrl) {
  report.endToEnd = {
    baseline: await measureRequest("Baseline", baselineUrl, pdfPayload),
    optimized: await measureRequest("Optimized", optimizedUrl, textPayload),
  };
  report.endToEnd.improvementPercent = Number(
    ((1 - report.endToEnd.optimized.durationMs / report.endToEnd.baseline.durationMs) * 100).toFixed(1),
  );
}

console.log(JSON.stringify(report, null, 2));
