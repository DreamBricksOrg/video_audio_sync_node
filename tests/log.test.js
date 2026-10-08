const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createLogger } = require("../src/log");

function capture(options) {
  const lines = [];
  const reported = [];
  const log = createLogger({
    ...options,
    write: (level, line) => lines.push([level, line]),
    report: (err, context) => reported.push([err, context]),
  });
  return { log, lines, reported };
}

test("text format keeps the familiar [Scope] message lines", () => {
  const { log, lines } = capture({ format: "text" });
  log.info("Media", "Saved video a.mp4");
  log.warn("Auth", "Failed login from", "1.2.3.4");
  log.error("Stats", "Save failed:", new Error("S3 down"));
  assert.deepEqual(lines, [
    ["info", "[Media] Saved video a.mp4"],
    ["warn", "[Auth] Failed login from 1.2.3.4"],
    ["error", "[Stats] Save failed: S3 down"],
  ]);
});

test("json format: one object per line with time, level, scope, message and error", () => {
  const { log, lines } = capture({ format: "json", now: () => new Date("2026-10-08T12:00:00Z") });
  log.info("Screen", "totem1/abc connected");
  const err = new Error("boom");
  log.error("Media", "Split failed:", err);
  const first = JSON.parse(lines[0][1]);
  assert.deepEqual(first, { time: "2026-10-08T12:00:00.000Z", level: "info", scope: "Screen", msg: "totem1/abc connected" });
  const second = JSON.parse(lines[1][1]);
  assert.equal(second.level, "error");
  assert.equal(second.msg, "Split failed: boom");
  assert.equal(second.error.message, "boom");
  assert.match(second.error.stack, /boom/);
});

test("errors are reported (Sentry); info and warn are not", () => {
  const { log, reported } = capture({ format: "text" });
  log.info("A", "fine");
  log.warn("A", "hmm");
  log.error("Config", "Refresh failed:", "S3 timeout");
  log.error("Media", "Write failed", new Error("disk full"));
  assert.equal(reported.length, 2);
  assert.equal(reported[0][0].message, "[Config] Refresh failed: S3 timeout");
  assert.equal(reported[1][0].message, "disk full");
  assert.deepEqual(reported[1][1], { scope: "Media", msg: "Write failed disk full" });
});
