// Regression harness for audition-sides parsing: runs the real client
// extraction (annotation/markup handling in src/lib) and the real server
// pipeline (api/_layout + api/_sides) against the sides PDFs in test_data,
// then asserts each file's known ground truth (sides-fixtures.ts) — struck/
// hidden content stays out, START/END selections are honored, characters are
// right.
//
// No network or model calls: only the deterministic strategy is exercised.
// strategy-compare.ts scores the model strategies against the same answers.
//
//   npm run bench:sides            # run assertions
//   npm run bench:sides -- --dump  # print each file's parsed output
//
// Run with tsx (node's type stripping doesn't map the ".js" ESM specifiers
// the api/ modules use).

import type { PdfLayoutResult } from "../../src/lib/pdf";
import { flattenLayout, parseScreenplayLayout } from "../../api/_layout.js";
import { EXPECTATIONS, extractSides } from "./sides-fixtures";

const DUMP = process.argv.includes("--dump");

type Parsed = {
  extracted: PdfLayoutResult;
  text: string;
  characters: string[];
  verbal: string;
};

async function parsePdf(fileName: string): Promise<Parsed> {
  const sides = await extractSides(fileName);
  const layout = parseScreenplayLayout(sides.lines, {
    relaxed: sides.cuesApplied,
  });

  return {
    extracted: sides.extracted,
    text: flattenLayout(sides.lines),
    characters: layout?.characters ?? [],
    verbal: (layout?.steps ?? [])
      .map((step) => step.verbalLine)
      .filter(Boolean)
      .join("\n"),
  };
}

let failures = 0;
const report = (file: string, ok: boolean, message: string) => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "✓" : "✗"} ${message}`);
};

for (const expectation of EXPECTATIONS) {
  console.log(`\n${expectation.file}`);
  let parsed: Parsed;
  try {
    parsed = await parsePdf(expectation.file);
  } catch (error) {
    failures += 1;
    console.log(`  ✗ failed to parse: ${(error as Error).message}`);
    continue;
  }

  if (DUMP) {
    console.log("--- sides:", JSON.stringify(parsed.extracted.sides));
    console.log("--- characters:", parsed.characters.join(", "));
    console.log(parsed.text);
    continue;
  }

  if (expectation.expectVision) {
    report(
      expectation.file,
      parsed.extracted.sides.visionRecommended,
      "routes to vision (raster markup overlay)",
    );
    continue;
  }

  if (expectation.expectSidesDetected !== undefined) {
    report(
      expectation.file,
      parsed.extracted.sides.detected === expectation.expectSidesDetected,
      `sides detected = ${expectation.expectSidesDetected}`,
    );
    report(
      expectation.file,
      !parsed.extracted.sides.visionRecommended,
      "not routed to vision",
    );
  }
  for (const needle of expectation.includes ?? []) {
    report(
      expectation.file,
      parsed.text.includes(needle),
      `includes "${needle}"`,
    );
  }
  for (const needle of expectation.excludes ?? []) {
    report(
      expectation.file,
      !parsed.text.includes(needle),
      `excludes "${needle}"`,
    );
  }
  for (const needle of expectation.verbalIncludes ?? []) {
    report(
      expectation.file,
      parsed.verbal.includes(needle),
      `speaks "${needle}"`,
    );
  }
  for (const character of expectation.characters ?? []) {
    report(
      expectation.file,
      parsed.characters.includes(character),
      `character "${character}" found (got: ${parsed.characters.join(", ") || "none"})`,
    );
  }
}

console.log(
  failures === 0
    ? "\nAll sides assertions passed."
    : `\n${failures} assertion(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
