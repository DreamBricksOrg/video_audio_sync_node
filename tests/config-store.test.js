const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createFileConfigStore, createS3ConfigStore, isConfigConflict } = require("../lib/config-store");
const { createS3Storage } = require("../lib/s3-storage");
const { startFakeS3 } = require("./helpers/fake-s3");

let s3;
before(async () => { s3 = await startFakeS3(); });
after(() => s3.stop());

// Each "server" gets its own S3 client, like two machines sharing a bucket
const storageFor = prefix => createS3Storage({
  bucket: "midia", prefix, region: "us-east-1", endpoint: s3.endpoint,
  client: undefined,
});
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || "test";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || "test";

test("file store: missing file loads as empty, saves atomically, never has remote changes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-"));
  try {
    const file = path.join(dir, "totems.json");
    const store = createFileConfigStore({ file });
    assert.deepEqual(await store.load(), {});
    await store.save({ t1: { video: "a.mp4" } });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { t1: { video: "a.mp4" } });
    assert.deepEqual(await createFileConfigStore({ file }).load(), { t1: { video: "a.mp4" } });
    assert.equal(await store.refresh(), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("s3 store: first load seeds the bucket from the local config", async () => {
  const store = createS3ConfigStore({ storage: storageFor("seed"), seed: () => ({ t1: { video: "local.mp4" } }) });
  assert.deepEqual(await store.load(), { t1: { video: "local.mp4" } });
  assert.deepEqual(JSON.parse(s3.objects.get("midia/seed/totems.json").body), { t1: { video: "local.mp4" } });

  // A second server finds it there and ignores its own local seed
  const other = createS3ConfigStore({ storage: storageFor("seed"), seed: () => ({ other: {} }) });
  assert.deepEqual(await other.load(), { t1: { video: "local.mp4" } });
});

test("s3 store: changes from one server reach the other on refresh", async () => {
  const a = createS3ConfigStore({ storage: storageFor("share"), seed: () => ({}) });
  const b = createS3ConfigStore({ storage: storageFor("share"), seed: () => ({}) });
  await a.load();
  await b.load();
  assert.equal(await b.refresh(), null, "nothing changed yet");

  await a.save({ t1: { video: "new.mp4" } });
  assert.deepEqual(await b.refresh(), { t1: { video: "new.mp4" } });
  assert.equal(await b.refresh(), null, "already up to date");
});

test("s3 store: a stale save is rejected as a conflict instead of overwriting", async () => {
  const a = createS3ConfigStore({ storage: storageFor("race"), seed: () => ({}) });
  const b = createS3ConfigStore({ storage: storageFor("race"), seed: () => ({}) });
  await a.load();
  await b.load();
  await a.save({ fromA: true });

  await assert.rejects(b.save({ fromB: true }), err => isConfigConflict(err));
  assert.deepEqual(JSON.parse(s3.objects.get("midia/race/totems.json").body), { fromA: true }, "A's write kept");

  await b.refresh();
  await b.save({ fromA: true, fromB: true });
  assert.deepEqual(JSON.parse(s3.objects.get("midia/race/totems.json").body), { fromA: true, fromB: true });
});
