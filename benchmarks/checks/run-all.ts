// Runs every check suite (`npm test`): each *.ts file in this folder, plus
// the emotiveness harness in dry-run mode. Every suite runs even after one
// fails, so a single run shows everything that's broken; the exit code is
// non-zero if any suite failed. None of them call a paid API.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const self = basename(fileURLToPath(import.meta.url));

const suites: string[][] = [
  ...readdirSync(here)
    .filter((name) => name.endsWith(".ts") && name !== self)
    .sort()
    .map((name) => [join(here, name)]),
  [join(here, "..", "voice", "emotion.ts"), "--dry-run", "--quick"],
];

const failed: string[] = [];
for (const [file, ...args] of suites) {
  const label = relative(process.cwd(), file);
  console.log(`\n=== ${label} ${args.join(" ")}`.trimEnd());
  const result = spawnSync(process.execPath, ["--import", "tsx", file, ...args], {
    stdio: "inherit",
  });
  if (result.status !== 0) failed.push(label);
}

console.log(
  failed.length === 0
    ? `\nAll ${suites.length} check suites passed.`
    : `\n${failed.length} of ${suites.length} check suites failed: ${failed.join(", ")}`,
);
process.exit(failed.length === 0 ? 0 : 1);
