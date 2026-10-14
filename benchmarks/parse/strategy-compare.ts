// Parse-strategy comparison: runs every strategy in the parse-script chain on
// the same sides PDFs and scores each against the known ground truth in
// sides-fixtures.ts. Answers "would always using the model parse better?".
//
// Strategies (the real exported functions from api/parse-script.ts):
//   rules       deterministic indent-based screenplay parse (no model)
//   haiku-text  regex segmentation + Haiku classifier on the extracted text
//   sonnet-text Sonnet full parse of the extracted text
//   sonnet-pdf  Sonnet full parse of the raw PDF — the model must read the
//               strikes, covers and START/END cues itself
//
// The text strategies get exactly what the server gets: client extraction
// with sides markup applied (struck text already removed), trimmed to the
// START/END selection.
//
// Scores per file and strategy:
//   truth     ground-truth assertions passed (includes / excludes / spoken
//             lines / characters), checked against the parsed steps
//   verbatim  share of spoken lines that appear word-for-word in the PDF text
//             (catches paraphrase, "fixed" grammar, invented words)
//   stable    with --runs > 1, whether every run produced identical steps
//   vs rules  spoken lines (speaker + text) this strategy and the rules
//             parser disagree on — where a role, speaker or split differs
//
// Costs money (Anthropic): one Haiku + two Sonnet calls per file per run.
//
//   npm run bench:strategies
//   npm run bench:strategies -- --runs 3
//   npm run bench:strategies -- --only rules,sonnet-pdf --file CANNED

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ParsedStep } from "../../api/_screenplay.js";
import { flattenLayout, parseScreenplayLayout } from "../../api/_layout.js";
import {
  parseFull,
  parseTextFast,
  type ModelUsage,
} from "../../api/parse-script.js";
import {
  EXPECTATIONS,
  extractSides,
  fixtureExists,
  readFixture,
  type Expectation,
} from "./sides-fixtures.js";

const STRATEGIES = ["rules", "haiku-text", "sonnet-text", "sonnet-pdf"] as const;
type Strategy = (typeof STRATEGIES)[number];

const argValue = (flag: string) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
};
const RUNS = Math.max(1, Number(argValue("--runs") ?? 1));
const ONLY = argValue("--only")?.split(",") as Strategy[] | undefined;
const FILE_FILTER = argValue("--file");
const strategies = STRATEGIES.filter((s) => !ONLY || ONLY.includes(s));
if (strategies.some((s) => s !== "rules") && !process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set (npm script loads .env.local).");
  process.exit(1);
}

type Attempt = {
  steps: ParsedStep[] | null;
  characters: string[];
  /** Why the strategy produced nothing (declined, error). */
  failure?: string;
  durationMs: number;
  usage?: ModelUsage;
};

type FileInput = {
  /** Selection text the text strategies receive. */
  text: string;
  layout: Awaited<ReturnType<typeof extractSides>>;
  pdfBase64: string;
};

async function runStrategy(strategy: Strategy, input: FileInput): Promise<Attempt> {
  const startedAt = performance.now();
  const elapsed = () => Math.round(performance.now() - startedAt);
  try {
    if (strategy === "rules") {
      const parsed = parseScreenplayLayout(input.layout.lines, {
        relaxed: input.layout.cuesApplied,
      });
      return parsed
        ? { ...parsed, durationMs: elapsed() }
        : { steps: null, characters: [], failure: "declined", durationMs: elapsed() };
    }
    if (strategy === "haiku-text") {
      const fast = await parseTextFast(input.text);
      if (!fast) {
        return { steps: null, characters: [], failure: "declined", durationMs: elapsed() };
      }
      return {
        steps: fast.payload.steps as ParsedStep[],
        characters: fast.payload.characters,
        durationMs: elapsed(),
        usage: fast.usage,
      };
    }
    const full = await parseFull(
      strategy === "sonnet-text"
        ? { scriptText: input.text }
        : { pdfData: input.pdfBase64 },
    );
    if (!full.ok) {
      return { steps: null, characters: [], failure: full.error, durationMs: elapsed() };
    }
    return {
      steps: full.payload.steps as ParsedStep[],
      characters: full.payload.characters,
      durationMs: elapsed(),
      usage: full.usage,
    };
  } catch (error) {
    return {
      steps: null,
      characters: [],
      failure: (error as Error).message,
      durationMs: elapsed(),
    };
  }
}

/** Fold typography and line wrapping so verbatim checks compare words. */
function normalize(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/-\s+/g, "-") // "can-\ndo" wraps to "can- do"
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

type Check = { label: string; ok: boolean };

function scoreTruth(attempt: Attempt, expectation: Expectation): Check[] {
  const steps = attempt.steps ?? [];
  const all = normalize(steps.flatMap((s) => s.content.map((c) => c.text)).join(" "));
  const spoken = normalize(steps.map((s) => s.verbalLine).join(" "));
  const checks: Check[] = [];
  for (const needle of expectation.includes ?? []) {
    checks.push({ label: `includes "${needle}"`, ok: all.includes(normalize(needle)) });
  }
  for (const needle of expectation.excludes ?? []) {
    checks.push({ label: `excludes "${needle}"`, ok: !all.includes(normalize(needle)) });
  }
  for (const needle of expectation.verbalIncludes ?? []) {
    checks.push({ label: `speaks "${needle}"`, ok: spoken.includes(normalize(needle)) });
  }
  for (const character of expectation.characters ?? []) {
    checks.push({
      label: `character "${character}"`,
      ok: attempt.characters.some((c) => c.toUpperCase() === character.toUpperCase()),
    });
  }
  return checks;
}

/** Spoken lines that don't appear word-for-word anywhere in the PDF text. */
function nonVerbatimLines(attempt: Attempt, sourceText: string): { total: number; misses: string[] } {
  const source = normalize(sourceText);
  const lines = (attempt.steps ?? [])
    .flatMap((s) => s.content)
    .filter((c) => c.kind === "verbal" && c.text.trim());
  const misses = lines
    .map((c) => c.text)
    .filter((text) => !source.includes(normalize(text)));
  return { total: lines.length, misses };
}

/**
 * Spoken lines as "SPEAKER: text", diffed as multisets against the rules
 * parse. A line split, merged, reassigned or demoted to a direction shows up
 * on both sides.
 */
function spokenDiff(attempt: Attempt, rules: Attempt): { onlyHere: string[]; onlyRules: string[] } {
  const keyed = (a: Attempt) =>
    (a.steps ?? [])
      .filter((s) => s.verbalLine.trim())
      .map((s) => `${s.speaker.toUpperCase()}: ${s.verbalLine}`);
  const remaining = new Map<string, number>();
  for (const line of keyed(rules)) {
    remaining.set(normalize(line), (remaining.get(normalize(line)) ?? 0) + 1);
  }
  const onlyHere: string[] = [];
  for (const line of keyed(attempt)) {
    const count = remaining.get(normalize(line)) ?? 0;
    if (count) remaining.set(normalize(line), count - 1);
    else onlyHere.push(line);
  }
  const onlyRules = keyed(rules).filter((line) => {
    const count = remaining.get(normalize(line)) ?? 0;
    if (!count) return false;
    remaining.set(normalize(line), count - 1);
    return true;
  });
  return { onlyHere, onlyRules };
}

const signature = (attempt: Attempt) =>
  JSON.stringify(
    (attempt.steps ?? []).map((s) => [s.speaker, s.content.map((c) => [c.kind, c.text])]),
  );

type Row = {
  file: string;
  strategy: Strategy;
  truthPassed: number;
  truthTotal: number;
  failedChecks: string[];
  verbatimLines: number;
  verbatimTotal: number;
  nonVerbatim: string[];
  /** Spoken lines only this strategy produced, vs the rules parser. */
  onlyHere: string[];
  /** Spoken lines only the rules parser produced. */
  onlyRules: string[];
  steps: number;
  characters: string[];
  stable: boolean | null;
  failures: string[];
  medianMs: number;
  inputTokens: number;
  outputTokens: number;
  parsed: ParsedStep[] | null;
};

const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

const fixtures = EXPECTATIONS.filter(
  (e) =>
    !e.expectVision && (!FILE_FILTER || e.file.includes(FILE_FILTER)),
);

const rows: Row[] = [];
for (const expectation of fixtures) {
  if (!fixtureExists(expectation.file)) {
    console.log(`\n${expectation.file}: not in test_data, skipped`);
    continue;
  }
  const layout = await extractSides(expectation.file);
  const input: FileInput = {
    text: flattenLayout(layout.lines),
    layout,
    pdfBase64: readFixture(expectation.file).toString("base64"),
  };
  // Every word on the page, cut text included — verbatim means "copied from
  // the PDF", independent of whether the strategy honored the cuts.
  const sourceText = flattenLayout(layout.cleanedLines);

  console.log(`\n${expectation.file}`);
  // Strategies run in parallel within a run.
  const attempts = new Map<Strategy, Attempt[]>(strategies.map((s) => [s, []]));
  for (let run = 0; run < RUNS; run++) {
    const results = await Promise.all(strategies.map((s) => runStrategy(s, input)));
    strategies.forEach((s, i) => attempts.get(s)!.push(results[i]));
  }
  const rulesRun = attempts.get("rules")?.[0];

  for (const strategy of strategies) {
    const runs = attempts.get(strategy)!;
    // Score the first run; later runs only feed stability and timing.
    const first = runs[0];
    const checks = scoreTruth(first, expectation);
    const verbatim = nonVerbatimLines(first, sourceText);
    const diff =
      rulesRun?.steps && strategy !== "rules"
        ? spokenDiff(first, rulesRun)
        : { onlyHere: [], onlyRules: [] };
    const row: Row = {
      file: expectation.file,
      strategy,
      truthPassed: checks.filter((c) => c.ok).length,
      truthTotal: checks.length,
      failedChecks: checks.filter((c) => !c.ok).map((c) => c.label),
      verbatimLines: verbatim.total - verbatim.misses.length,
      verbatimTotal: verbatim.total,
      nonVerbatim: verbatim.misses,
      onlyHere: diff.onlyHere,
      onlyRules: diff.onlyRules,
      steps: first.steps?.length ?? 0,
      characters: first.characters,
      stable: runs.length > 1 ? new Set(runs.map(signature)).size === 1 : null,
      failures: runs.flatMap((r) => (r.failure ? [r.failure] : [])),
      medianMs: median(runs.map((r) => r.durationMs)),
      inputTokens: runs.reduce((n, r) => n + (r.usage?.inputTokens ?? 0), 0),
      outputTokens: runs.reduce((n, r) => n + (r.usage?.outputTokens ?? 0), 0),
      parsed: first.steps,
    };
    rows.push(row);

    const verbatimPct = row.verbatimTotal
      ? `${Math.round((row.verbatimLines / row.verbatimTotal) * 100)}%`
      : "—";
    console.log(
      `  ${strategy.padEnd(12)} truth ${`${row.truthPassed}/${row.truthTotal}`.padEnd(6)}` +
        ` verbatim ${verbatimPct.padEnd(5)} steps ${String(row.steps).padEnd(4)}` +
        ` ${String(row.medianMs).padStart(6)}ms` +
        (strategy === "rules" || !rulesRun?.steps
          ? ""
          : `  vs rules ${row.onlyHere.length}/${row.onlyRules.length}`) +
        (row.stable === null ? "" : row.stable ? "  stable" : "  UNSTABLE") +
        (row.failures.length ? `  [${row.failures.join("; ")}]` : ""),
    );
    for (const label of row.failedChecks) console.log(`      ✗ ${label}`);
    for (const line of row.nonVerbatim.slice(0, 5)) {
      console.log(`      ≠ ${line.length > 90 ? `${line.slice(0, 90)}…` : line}`);
    }
    if (row.nonVerbatim.length > 5) {
      console.log(`      ≠ …and ${row.nonVerbatim.length - 5} more`);
    }
    const clip = (line: string) => (line.length > 90 ? `${line.slice(0, 90)}…` : line);
    for (const line of row.onlyHere.slice(0, 3)) console.log(`      + ${clip(line)}`);
    for (const line of row.onlyRules.slice(0, 3)) console.log(`      - ${clip(line)}`);
  }
}

if (rows.length) {
  console.log("\nTotals");
  for (const strategy of strategies) {
    const mine = rows.filter((r) => r.strategy === strategy);
    const sum = (pick: (r: Row) => number) => mine.reduce((n, r) => n + pick(r), 0);
    const verbatimTotal = sum((r) => r.verbatimTotal);
    console.log(
      `  ${strategy.padEnd(12)} truth ${sum((r) => r.truthPassed)}/${sum((r) => r.truthTotal)}` +
        `  verbatim ${verbatimTotal ? Math.round((sum((r) => r.verbatimLines) / verbatimTotal) * 100) : 0}%` +
        `  median ${median(mine.map((r) => r.medianMs))}ms` +
        `  tokens in/out ${sum((r) => r.inputTokens)}/${sum((r) => r.outputTokens)}` +
        (RUNS > 1 ? `  stable ${mine.filter((r) => r.stable).length}/${mine.length}` : ""),
    );
  }

  const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "out");
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `strategy-compare-${Date.now()}.json`);
  writeFileSync(outFile, JSON.stringify({ runs: RUNS, rows }, null, 2));
  console.log(`\nWrote ${outFile}`);
}
