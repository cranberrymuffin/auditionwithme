// Checks for localDb's withStore: a write only counts once its transaction
// commits, so a transaction that aborts after its request succeeded (a full
// disk) rejects instead of looking saved. Runs against a minimal in-memory
// stand-in for IndexedDB — just the calls withStore makes.
//
//   npx tsx benchmarks/checks/local-db.ts
//
// Run with tsx (no test runner in this repo; failures exit non-zero).

import assert from "node:assert/strict";

type Handler = (() => void) | null;

/** How the next transaction ends once its request has succeeded. */
let outcome: "commit" | "abort" = "commit";
const events: string[] = [];

class FakeRequest {
  onsuccess: Handler = null;
  onerror: Handler = null;
  result: unknown = undefined;
  error: DOMException | null = null;
}

class FakeTransaction {
  oncomplete: Handler = null;
  onerror: Handler = null;
  onabort: Handler = null;
  error: DOMException | null = null;
  constructor(private rows: Map<string, unknown>) {}

  objectStore() {
    const settle = (apply: () => unknown) => {
      const request = new FakeRequest();
      setTimeout(() => {
        const previous = new Map(this.rows);
        request.result = apply();
        events.push("request success");
        request.onsuccess?.();
        setTimeout(() => {
          if (outcome === "abort") {
            // Roll the write back, as a real aborted transaction does.
            this.rows.clear();
            previous.forEach((value, key) => this.rows.set(key, value));
            this.error = new DOMException("The quota has been exceeded.", "QuotaExceededError");
            events.push("tx abort");
            this.onabort?.();
            return;
          }
          events.push("tx complete");
          this.oncomplete?.();
        }, 0);
      }, 0);
      return request;
    };
    return {
      put: (record: { id: string }) => settle(() => (this.rows.set(record.id, record), record.id)),
      get: (key: string) => settle(() => this.rows.get(key)),
    };
  }
}

const rows = new Map<string, unknown>();
(globalThis as unknown as { indexedDB: unknown }).indexedDB = {
  open() {
    const request = new FakeRequest() as FakeRequest & { onupgradeneeded: Handler; onblocked: Handler };
    request.onupgradeneeded = null;
    request.onblocked = null;
    request.result = { transaction: () => new FakeTransaction(rows), onversionchange: null };
    setTimeout(() => request.onsuccess?.(), 0);
    return request;
  },
};

const { withStore, isStorageFullError, SELF_TAPES_STORE } = await import("../../src/lib/localDb");

let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  events.length = 0;
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

type Store = { put: (record: { id: string }) => IDBRequest<IDBValidKey>; get: (key: string) => IDBRequest<unknown> };
const put = (id: string) =>
  withStore(SELF_TAPES_STORE, "readwrite", (store) => (store as unknown as Store).put({ id }));
const get = (id: string) =>
  withStore(SELF_TAPES_STORE, "readonly", (store) => (store as unknown as Store).get(id));

await check("a write resolves with the request's result, after the transaction commits", async () => {
  outcome = "commit";
  let settledAt = -1;
  const result = await put("take-1").then((value) => {
    settledAt = events.length;
    return value;
  });
  assert.equal(result, "take-1");
  assert.deepEqual(events, ["request success", "tx complete"]);
  assert.equal(settledAt, 2);
});

await check("a read resolves with the stored record", async () => {
  outcome = "commit";
  assert.deepEqual(await get("take-1"), { id: "take-1" });
  assert.equal(await get("missing"), undefined);
});

await check("a transaction that aborts after its request succeeded rejects", async () => {
  outcome = "abort";
  await assert.rejects(put("take-2"), (err) => {
    assert.ok(isStorageFullError(err), "the transaction's own error is what's reported");
    return true;
  });
  assert.deepEqual(events, ["request success", "tx abort"]);
  outcome = "commit";
  assert.equal(await get("take-2"), undefined);
});

await check("only a quota failure reads as storage full", async () => {
  assert.equal(isStorageFullError(new DOMException("full", "QuotaExceededError")), true);
  assert.equal(isStorageFullError(new DOMException("gone", "InvalidStateError")), false);
  assert.equal(isStorageFullError(new Error("QuotaExceededError")), false);
});

console.log(`\n${passed} checks passed`);
