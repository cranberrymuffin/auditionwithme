# CLAUDE.md

Audition With Me: rehearsal tool for actors. React 19 + Vite web app, Vercel serverless functions, Supabase, Stripe, Capacitor iOS shell. See README.md for setup, env vars and deploy.

## Commands

```sh
npm run dev         # dev server; also serves api/ (see vite.config.ts)
npm run typecheck   # src/ + vite.config.ts + api/
npm run lint
npm test            # all suites in benchmarks/checks/ (no paid API calls)
npm run build       # typecheck + vite build + prerender; what Vercel runs
```

Run typecheck, lint and test before calling a change done. One suite: `npm run test:<name>` or `npx tsx benchmarks/checks/<file>.ts`.

## Layout

- `src/` — the client. `pages/`, `components/`, `hooks/`, `contexts/`, `lib/` (pure logic and local stores), `lib/native/` (iOS bridges), `types.ts`, `entry-server.tsx` (prerender entry).
- `api/` — Vercel functions, one per file. Files starting with `_` are shared helpers, not endpoints. Own tsconfig (`api/tsconfig.json`, NodeNext, so relative imports end in `.js`).
- `supabase/migrations/` — SQL migrations. Merging one to `main` applies it to production.
- `scripts/` — `prerender.mjs` (build step) and ops scripts that act on live Supabase/Stripe.
- `tools/` — build guards (`check-prod-env.mjs`).
- `benchmarks/checks/` — the tests. `benchmarks/parse/`, `benchmarks/voice/` — paid benchmarks; see `benchmarks/README.md`.
- `ios/` — Capacitor iOS project. `dist/` is its web bundle.

## Conventions

- Commit messages are one imperative sentence describing the change as a user or operator would see it ("Stop the actor's voice dropping out of native takes"), not the implementation. No prefixes, no trailers.
- Comments explain why, not what: the constraint, the failure being avoided, the thing that looks wrong but isn't. Don't add comments that restate the code.
- No test runner: a check is a `tsx` script using `node:assert` that exits non-zero. A new `*.ts` file in `benchmarks/checks/` is run by `npm test` automatically.
- Keep logic that needs testing pure and in `src/lib/` so a check can import it without a browser.
- Scripts and recordings are stored on the device only (IndexedDB / app storage). Don't add server-side storage of script text, audio or video, and keep any privacy wording accurate about what is sent to Anthropic and ElevenLabs for processing (README, "Where an actor's material goes").

## Design system

Styles live in `src/styles/`, imported in cascade order by `src/index.css`: `tokens.css`, `base.css`, `components.css`, `script.css` (the system), then one file per area.

- Use the tokens in `tokens.css` for every colour, size, space, radius and shadow; no hex or `rgb()` literals in area files. Coral (`--accent`) is for the primary action, "your line" and focus only.
- Compose the shared classes before writing new ones: `.btn-primary/-secondary/-ghost/-danger`, `.form` + `.field-label` + `.input`, `.notice`, `.tag`, `.qa`, `.modal-*`, and the layout helpers `.page`, `.wrap`, `.grid` with `.span-N`/`.at-N`.
- One rule per typeface: Playfair (`.title`, `.display`) for page titles only; Britti Sans for interface and body; Courier Prime (`--font-script`, `.sides-*`, `.slug`, `.slate`) for script content, file names, timers and counts.
- Flat and ruled: hairlines and space instead of boxes, no gradients, glows, blur or decorative icons. Breakpoints are 560 / 900 / 1200 plus the landscape-phone query documented in `tokens.css`.
- Class names that collide with Tailwind utilities get overridden silently (`col-4` did): check a new generic name against Tailwind first.

## Gotchas

- `api/` imports from `src/`: `src/lib/beta.ts`, `src/lib/plan.ts`, `src/lib/termsText.ts`, `src/types.ts`. Those files run in both the browser and Node, so no DOM or `import.meta.env`-only code in them (see how `beta.ts` reads its flag), and a change there needs `npm run typecheck`, which covers both sides.
- Anything prefixed `VITE_` is public once built. `VITE_VERCEL_BYPASS_SECRET` is for staging/local iOS builds only; `tools/check-prod-env.mjs` fails production builds that have it.
- `VITE_BETA_TESTING` switches NDA/free beta versus Terms/paywall, on the client and in the functions. Check both branches when touching signup, billing or entitlements.
- Env files: `npm run dev` reads `.env.local`; the ops scripts and `bench:strategies` read `.env.development.local`.
- Never run anything that writes to live Stripe or Supabase without a dry run first: `scripts/*.mjs` (`npm run ops:*`, `reset-stale-billing`, `purge-*`, `stripe-setup`) and `supabase db push`. The delete, purge and reset scripts are dry-run unless passed `--confirm`; `set-admin` and `stripe-setup` write immediately. Use `supabase db push --dry-run`. Ask before the real run.
- `npm run bench:*` calls paid APIs. `npm test` and `npm run test:*` do not.
- Never print or commit values from `.env*` files.
