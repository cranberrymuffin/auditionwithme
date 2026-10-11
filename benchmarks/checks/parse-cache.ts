// Checks for the parse cache: the first write creates the script row, every
// later one (Continue, the language pick, a StrictMode double call) updates
// that same row, writes never overlap, and a failed create is retried under
// the same id. Pure logic, no browser or IndexedDB.
//
//   npm run test:parse-cache
//
// Run with tsx (no test runner in this repo; failures exit non-zero).

import assert from "node:assert/strict";
import { createParseCache, type CachedParseFields } from "../../src/lib/parseCache";

let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

const fields = (overrides: Partial<CachedParseFields> = {}): CachedParseFields => ({
  steps: [],
  characters: ["MARY"],
  languageCode: "en",
  languageName: "English",
  needsLanguageChoice: false,
  ...overrides,
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeStore(options: { failCreates?: number } = {}) {
  const rows = new Map<string, CachedParseFields>();
  const log: string[] = [];
  let ids = 0;
  let failCreates = options.failCreates ?? 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const track = async (work: () => void) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await tick(); // writes are async, like IndexedDB
    inFlight -= 1;
    work();
  };
  const created: string[] = [];
  const errors: unknown[] = [];
  return {
    rows,
    log,
    created,
    errors,
    maxInFlight: () => maxInFlight,
    deps: {
      newId: () => `row-${++ids}`,
      create: (id: string, value: CachedParseFields) =>
        track(() => {
          if (failCreates > 0) {
            failCreates -= 1;
            throw new Error("quota");
          }
          log.push(`create ${id}`);
          rows.set(id, value);
        }),
      update: (id: string, value: CachedParseFields) =>
        track(() => {
          // Mirrors scriptStore.updateScript: a missing row is a silent no-op.
          if (!rows.has(id)) return;
          log.push(`update ${id}`);
          rows.set(id, value);
        }),
      onCreated: (id: string) => created.push(id),
      onError: (err: unknown) => errors.push(err),
    },
  };
}

await check("first write creates the row and reports its id", async () => {
  const store = fakeStore();
  const cache = createParseCache(store.deps);
  await cache(fields());
  assert.deepEqual(store.log, ["create row-1"]);
  assert.deepEqual(store.created, ["row-1"]);
});

await check("Continue right after the parse updates the same row, never a second one", async () => {
  const store = fakeStore();
  const cache = createParseCache(store.deps);
  // Not awaited in between: Continue fires while the create is still in flight.
  void cache(fields({ languageName: "Parsed" }));
  await cache(fields({ languageName: "Confirmed" }));
  assert.deepEqual(store.log, ["create row-1", "update row-1"]);
  assert.equal(store.rows.size, 1);
  assert.equal(store.rows.get("row-1")?.languageName, "Confirmed");
  assert.equal(store.maxInFlight(), 1);
});

await check("a doubled call (StrictMode) leaves exactly one row", async () => {
  const store = fakeStore();
  const cache = createParseCache(store.deps);
  await Promise.all([cache(fields()), cache(fields())]);
  assert.equal(store.rows.size, 1);
  assert.deepEqual(store.created, ["row-1"]);
});

await check("bilingual: the language pick clears needsLanguageChoice on the saved row", async () => {
  const store = fakeStore();
  const cache = createParseCache(store.deps);
  await cache(fields({ needsLanguageChoice: true, languageName: "English" }));
  assert.equal(store.rows.get("row-1")?.needsLanguageChoice, true);
  await cache(fields({ needsLanguageChoice: false, languageName: "English" }));
  assert.equal(store.rows.get("row-1")?.needsLanguageChoice, false);
  assert.equal(store.rows.size, 1);
});

await check("replays update the row they came from instead of creating one", async () => {
  const store = fakeStore();
  store.rows.set("saved", fields({ needsLanguageChoice: true }));
  const cache = createParseCache({ ...store.deps, existingId: "saved" });
  await cache(fields({ needsLanguageChoice: false }));
  assert.deepEqual(store.log, ["update saved"]);
  assert.equal(store.rows.size, 1);
  assert.deepEqual(store.created, []);
});

await check("a failed create is reported, and the next write retries under the same id", async () => {
  const store = fakeStore({ failCreates: 1 });
  const cache = createParseCache(store.deps);
  await cache(fields());
  assert.equal(store.errors.length, 1);
  assert.equal(store.rows.size, 0);
  await cache(fields());
  assert.deepEqual(store.log, ["create row-1"]);
  assert.deepEqual(store.created, ["row-1"]);
});

console.log(`\n${passed} checks passed`);
