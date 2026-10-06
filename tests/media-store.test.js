const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLocalStore, createS3Store } = require("../lib/media-store");

const EXTS = [".mp4", ".mp3"];

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function tempFile(content) {
  const dir = tmp("src-");
  const file = path.join(dir, "upload.tmp");
  fs.writeFileSync(file, content);
  return file;
}

// In-memory stand-in for lib/s3-storage
function fakeStorage(initial = {}) {
  const objects = new Map(Object.entries(initial)); // name → content
  return {
    objects,
    describe: () => "s3://fake/",
    async list() {
      return [...objects].map(([filename, c]) => ({ filename, size: c.length, modified: new Date(0) }));
    },
    async upload(localPath, name) { objects.set(name, fs.readFileSync(localPath, "utf8")); },
    async rename(a, b) { objects.set(b, objects.get(a)); objects.delete(a); },
    async remove(name) { objects.delete(name); },
  };
}

test("local store: put, list, rename, remove", async () => {
  const dir = tmp("assets-");
  try {
    const store = createLocalStore({ dir, exts: EXTS });
    await store.init();
    fs.writeFileSync(path.join(dir, ".hidden.mp3"), "x");
    fs.writeFileSync(path.join(dir, "notes.txt"), "x");

    const src = tempFile("abc");
    await store.putFile(src, "b.mp3");
    assert.equal(fs.existsSync(src), false, "temp file is consumed");
    assert.deepEqual(store.list().map(m => [m.filename, m.size]), [["b.mp3", 3]]);
    assert.equal(store.has("b.mp3"), true);
    assert.equal(store.localPath("b.mp3"), path.join(dir, "b.mp3"));

    await store.rename("b.mp3", "c.mp3");
    assert.deepEqual(store.list().map(m => m.filename), ["c.mp3"]);
    await store.remove("c.mp3");
    assert.deepEqual(store.list(), []);
    assert.equal(store.localPath("c.mp3"), null);
    assert.equal(store.remote, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("s3 store: loads the bucket listing and keeps it in sync", async () => {
  const storage = fakeStorage({ "a.mp4": "video", "z.txt": "ignored" });
  const store = createS3Store({ storage, exts: EXTS });
  await store.init();
  assert.equal(store.status().ok, true);
  assert.equal(store.remote, true);
  assert.deepEqual(store.list().map(m => m.filename), ["a.mp4"]);

  const src = tempFile("audio!");
  await store.putFile(src, "b.mp3");
  assert.equal(fs.existsSync(src), false, "temp file is removed after upload");
  assert.equal(storage.objects.get("b.mp3"), "audio!");
  assert.deepEqual(store.list().map(m => [m.filename, m.size]), [["a.mp4", 5], ["b.mp3", 6]]);

  await store.rename("b.mp3", "c.mp3");
  assert.equal(store.has("b.mp3"), false);
  assert.equal(store.has("c.mp3"), true);
  assert.equal(storage.objects.get("c.mp3"), "audio!");

  await store.remove("a.mp4");
  assert.deepEqual(store.list().map(m => m.filename), ["c.mp3"]);
  assert.equal(store.localPath("c.mp3"), null, "nothing is served from disk");
});

test("s3 store: failed upload throws, cleans the temp file and lists nothing new", async () => {
  const storage = fakeStorage();
  storage.upload = async () => { throw new Error("AccessDenied"); };
  const store = createS3Store({ storage, exts: EXTS });
  await store.init();
  const src = tempFile("x");
  await assert.rejects(store.putFile(src, "x.mp3"), /AccessDenied/);
  assert.equal(fs.existsSync(src), false);
  assert.deepEqual(store.list(), []);
});

test("s3 store: listing failure is reported in status", async () => {
  const storage = fakeStorage();
  storage.list = async () => { throw new Error("Access Denied"); };
  const store = createS3Store({ storage, exts: EXTS });
  await store.init();
  assert.equal(store.status().ok, false);
  assert.match(store.status().error, /Access Denied/);
});
