const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createSyncedDoc } = require("../lib/synced-doc");

// In-memory store with ETag-like versions, shared by several "servers"
function sharedStore(initial = {}) {
  const shared = { value: initial, version: 1 };
  return function storeFor() {
    let seen = 0;
    return {
      async load() { seen = shared.version; return structuredClone(shared.value); },
      async refresh() {
        if (seen === shared.version) return null;
        seen = shared.version;
        return structuredClone(shared.value);
      },
      async save(value) {
        if (seen !== shared.version) {
          const err = new Error("conflict");
          err.code = "PreconditionFailed";
          throw err;
        }
        shared.value = structuredClone(value);
        seen = ++shared.version;
      },
      shared,
    };
  };
}
const isConflict = err => err.code === "PreconditionFailed";

test("mutate applies the change, saves it and returns the mutator's result", async () => {
  const doc = createSyncedDoc({ store: sharedStore({ n: 1 })(), isConflict });
  await doc.load();
  const r = await doc.mutate(v => { v.n++; return "ok"; });
  assert.equal(r, "ok");
  assert.deepEqual(doc.get(), { n: 2 });
});

test("a conflicting save is retried on top of the other server's change", async () => {
  const storeFor = sharedStore({ list: [] });
  const a = createSyncedDoc({ store: storeFor(), isConflict });
  const b = createSyncedDoc({ store: storeFor(), isConflict });
  await a.load();
  await b.load();
  await a.mutate(v => { v.list.push("a"); });
  await b.mutate(v => { v.list.push("b"); }); // b was stale: reloads and reapplies
  assert.deepEqual(b.get().list, ["a", "b"]);
});

test("onChange fires when a refresh brings a newer version", async () => {
  const storeFor = sharedStore({ x: 1 });
  const changes = [];
  const a = createSyncedDoc({ store: storeFor(), isConflict });
  const b = createSyncedDoc({ store: storeFor(), isConflict, onChange: (prev, next) => changes.push([prev.x, next.x]) });
  await a.load();
  await b.load();
  await a.mutate(v => { v.x = 2; });
  assert.equal(await b.refresh(), true);
  assert.equal(await b.refresh(), false);
  assert.deepEqual(changes, [[1, 2]]);
});

test("errors thrown by the mutator abort without saving", async () => {
  const store = sharedStore({ n: 1 })();
  const doc = createSyncedDoc({ store, isConflict });
  await doc.load();
  await assert.rejects(doc.mutate(() => { throw new Error("nope"); }), /nope/);
  assert.deepEqual(store.shared.value, { n: 1 });
});

test("calls on the same doc run one at a time", async () => {
  const doc = createSyncedDoc({ store: sharedStore({ n: 0 })(), isConflict });
  await doc.load();
  await Promise.all(Array.from({ length: 10 }, () => doc.mutate(v => { v.n++; })));
  assert.equal(doc.get().n, 10);
});
