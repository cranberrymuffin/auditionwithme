# Audition With Me

A rehearsal tool for actors, on the web and as an iOS app. It turns a PDF script or audition sides into an interactive scene, reads the other characters aloud, follows the actor through their lines by listening, and records a self-tape of the take.

React 19 + Vite front end, Vercel serverless functions in `api/`, Supabase for auth and account data, Stripe for subscriptions, Capacitor for the iOS shell.

## What it does

- Parses full scripts and audition sides from PDF, including scanned pages and bilingual editions
- Identifies characters, dialogue, scene directions and marked sections
- Lets the actor pick their role and assign voices to the other characters
- Reads scene-partner lines aloud and tracks the actor's place in the script with live speech recognition
- Applies AI-directed delivery (pacing, emphasis, audio tags) to spoken lines without changing the words
- Records a self-tape of each take
- During beta: free, requires accepting the Beta Tester NDA at signup, and asks for a rating and comment on each take. With the paywall on (`VITE_BETA_TESTING=false`): signup requires accepting the Terms and Conditions instead, with a free trial followed by a subscription

## Where an actor's material goes

What is stored, and where:

- **Scripts, casting choices, rehearsal state, generated reader audio and self-tape video are stored only on the actor's device** (IndexedDB in the browser, app storage on iOS). The app's database has no table or bucket for scripts or recordings.
- **The app's database (Supabase) holds account data only:** the login, NDA/Terms acceptance, subscription state, and the rating, comment and per-take metrics (counts and timings, no script text or audio) submitted as feedback.

What is sent to third-party services for processing while the app is used:

| What | Sent to | Why |
| --- | --- | --- |
| Script text, or page images for scanned PDFs | Anthropic (Claude) | Parsing the script; matching voices to characters; directing line delivery |
| Each scene-partner line, plus a little of the surrounding dialogue | ElevenLabs | Speech synthesis |
| Live microphone audio during a rehearsal | ElevenLabs (Scribe) | Speech recognition that tracks the actor's place |
| Recorded coaching takes (audio) | ElevenLabs (speech-to-speech) | Re-voicing the take as the scene partner |

These requests pass through the app's own `api/` functions (or, for Scribe, go straight from the device with a single-use token). The app does not keep a copy of them; what each provider retains is governed by that provider's terms.

So: nothing an actor uploads is stored on our servers, but script content and audio do leave the device to be processed. Any user-facing copy should say that, not "nothing is uploaded".

## Local setup

Requires Node 22 or newer and npm.

```sh
npm install
cp .env.example .env.local   # then fill in the values
npm run dev                  # http://localhost:5173, with /api served by vite.config.ts
```

`npm run dev` runs the `api/` handlers inside the Vite dev server, so one process is enough. `npm run dev:vercel` runs the same thing under `vercel dev` instead.

## Environment variables

`.env.example` lists every name with a one-line description. Never commit real values; `.env*` is gitignored apart from the example.

| Name | Used by | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | api | Script parsing, voice casting, line direction |
| `ELEVENLABS_API_KEY` | api | Speech synthesis, speech-to-speech, Scribe tokens, voice catalog |
| `SUPABASE_SERVICE_ROLE_KEY` | api, ops scripts | Server-side database access that bypasses row-level security |
| `STRIPE_SECRET_KEY` | api, ops scripts | Stripe API |
| `STRIPE_WEBHOOK_SECRET` | api | Verifies `/api/stripe-webhook` calls |
| `STRIPE_PRICE_ID` | api | The subscription's price |
| `REHEARSAL_GRANT_SECRET` | api | Signs the short-lived grants the voice endpoints check |
| `VITE_SUPABASE_URL` | client, api, ops scripts | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | client, api | Supabase anon key |
| `VITE_STRIPE_PUBLISHABLE_KEY` | client | Stripe publishable key |
| `VITE_BETA_TESTING` | client, api | `false` turns the paywall on; anything else keeps beta mode. Must match between the build and the deployed functions |
| `VITE_WEB_ORIGIN` | client (iOS builds) | The deployed site the iOS app calls for `/api` and auth links |
| `APP_WEB_ORIGIN` | api (optional) | The web origin Stripe returns to after checkout. Defaults to the production site |
| `VITE_VERCEL_BYPASS_SECRET` | client (iOS staging/local builds) | Lets the iOS app through Vercel's protection on the staging deployment. **Must never be set for a production build**: every `VITE_*` value ships in the bundle. `tools/check-prod-env.mjs` fails `npm run build` on a Vercel production deploy, and `npm run ios:prod`, if it is set |
| `GEMINI_API_KEY` | benchmarks | Optional AI listening rater |

Which env file is read depends on the Vite mode:

| Command | Mode | Files (later wins) |
| --- | --- | --- |
| `npm run dev`, `npm run ios:local` | `development` | `.env.local`, `.env.development.local` |
| `npm run build` | `production` | `.env.local`, `.env.production.local` |
| `npm run ios:staging` | `staging` | `.env.local`, `.env.staging.local` |
| `npm run ios:prod` | `prod` | `.env.local`, `.env.prod.local` |

The ops scripts and `npm run bench:strategies` read `.env.development.local` specifically (then fall back to the shell environment), not `.env.local`. On Vercel the variables are set per environment in the project settings.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` / `dev:host` / `dev:vercel` | Dev server (local only / on the LAN / under `vercel dev`) |
| `npm run typecheck` | Type-checks `src/`, `vite.config.ts` and `api/` |
| `npm run lint` | ESLint |
| `npm test` | All check suites (see Testing) |
| `npm run build` | Type check, production build, then prerender of the public pages. This is what Vercel runs |
| `npm run ios:local` / `ios:staging` / `ios:prod` | Build the web bundle for the iOS shell and `cap sync` it (see iOS) |
| `npm run bench:*` | Benchmarks that call the real AI services and cost money (see `benchmarks/README.md`) |
| `npm run ops:delete-user -- <email>` | Deletes a user's account data. Dry run unless `--confirm` |
| `npm run ops:set-admin -- <email>` | Grants (`--remove`: revokes, `--list`: lists) admin access. Writes immediately, no dry run |
| `npm run ops:purge-script-pdfs` | Removes the retired script-PDF bucket. Dry run unless `--confirm` |

The `ops:*` scripts, and the other files in `scripts/`, act on whichever Supabase project and Stripe account the env file points at, including production. Run them without `--confirm` first and read the output.

## Testing

There is no test runner. Each suite in `benchmarks/checks/` is a `tsx` script that asserts and exits non-zero on failure; none of them call a paid API.

```sh
npm test               # every suite
npm run test:match     # one suite; see package.json for the rest
```

A pre-commit hook (`.husky/pre-commit`) runs lint and the type check. CI (`.github/workflows/ci.yml`) runs type check, lint, tests and a build on every pull request and on pushes to `main` and `staging`.

## Deploying

- **Web and API:** Vercel builds with `npm run build` and serves `api/*.ts` as functions. `vercel.json` holds the rewrites to the app shell, headers and function limits.
- **Database:** migrations live in `supabase/migrations/`. A push to `main` that changes one runs `.github/workflows/supabase-migrations.yml`, which applies it to the production database with `supabase db push`. The job uses the GitHub environment `production`; give that environment required reviewers so each migration waits for approval (setup notes are at the top of the workflow). Pull requests that touch a migration get a file-name check and, when the secrets are available, a `--dry-run`.

## iOS

The iOS app (`ios/`, Capacitor) is a native shell around the same web bundle, loaded from the device rather than from the site, so it needs `VITE_WEB_ORIGIN` to reach `/api`.

```sh
npm run ios:local     # development mode, API on this Mac at http://<LAN IP>:3000 (npm run dev:vercel)
npm run ios:staging   # staging mode (.env.staging.local)
npm run ios:prod      # prod mode (.env.prod.local); refuses to build with VITE_VERCEL_BYPASS_SECRET set
```

Each builds into `dist/` and runs `cap sync ios`; then build and run from Xcode (`ios/App/App.xcodeproj`). The underlying `ios:build:staging` and `ios:build:prod` skip the prerender step on purpose: prerendered marketing pages are for crawlers of the website, and the app only ever loads the shell.

## Branches

- `upstream` is the main repository; `origin` is a personal fork. Work happens on a feature branch pushed to `origin`, then a pull request into `upstream`.
- `main` is production: merging deploys the site and applies any new migrations.
- `staging` backs the access-protected staging deployment used for testing and for staging iOS builds.
