#!/usr/bin/env node
// Fails a production build that would bake the Vercel protection-bypass
// secret into the client bundle. src/lib/platform.ts reads
// VITE_VERCEL_BYPASS_SECRET so local and staging iOS builds can reach the
// SSO-protected staging deployment; anything prefixed VITE_ is public once
// built, so a production build must never see a value for it.
//
// Usage:
//   node tools/check-prod-env.mjs --mode prod   check that Vite mode's env
//   node tools/check-prod-env.mjs               check mode "production", but
//                                               only on a Vercel production
//                                               deploy (VERCEL_ENV=production)

import { loadEnv } from "vite";

const FORBIDDEN = ["VITE_VERCEL_BYPASS_SECRET"];

const modeFlag = process.argv.indexOf("--mode");
const mode = modeFlag !== -1 ? process.argv[modeFlag + 1] : undefined;
if (modeFlag !== -1 && !mode) {
  console.error("check-prod-env: --mode needs a value");
  process.exit(2);
}

if (!mode && process.env.VERCEL_ENV !== "production") process.exit(0);

// The same resolution Vite uses: .env, .env.local, .env.<mode>,
// .env.<mode>.local, then VITE_* already in the shell or CI environment.
const env = loadEnv(mode ?? "production", process.cwd(), "VITE_");
const set = FORBIDDEN.filter((name) => (env[name] ?? "").trim() !== "");

if (set.length > 0) {
  console.error(
    `check-prod-env: ${set.join(", ")} is set for a production build ` +
      `(mode "${mode ?? "production"}"). It would ship in the client bundle. ` +
      "Remove it from the production env files and the Vercel Production environment.",
  );
  process.exit(1);
}
