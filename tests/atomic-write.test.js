const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { writeJsonAtomic } = require("../lib/atomic-write");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "atomic-"));
}

test("writes pretty JSON and leaves no temp files behind", () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, "totems.json");
    writeJsonAtomic(file, { a: { video: "v.mp4" } });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { a: { video: "v.mp4" } });
    assert.match(fs.readFileSync(file, "utf8"), /\n {2}"a"/);
    assert.deepEqual(fs.readdirSync(dir), ["totems.json"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("replaces an existing file", () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, "totems.json");
    fs.writeFileSync(file, '{"old": true}');
    writeJsonAtomic(file, { new: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { new: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed write keeps the previous file intact", () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, "totems.json");
    fs.writeFileSync(file, '{"keep": true}');
    const circular = {};
    circular.self = circular; // JSON.stringify throws
    assert.throws(() => writeJsonAtomic(file, circular));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { keep: true });
    assert.deepEqual(fs.readdirSync(dir), ["totems.json"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
