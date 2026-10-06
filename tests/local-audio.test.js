const { test } = require("node:test");
const assert = require("node:assert/strict");
const { driftSeconds, shouldResync } = require("../static/js/local-audio");

test("drift is audio minus video", () => {
  assert.equal(driftSeconds(10.5, 10, 30), 0.5);
  assert.equal(driftSeconds(9.75, 10, 30), -0.25);
});

test("drift wraps around the loop point", () => {
  // video just looped to 0.1s, audio still at 29.9s → audio is 0.2s behind
  assert.ok(Math.abs(driftSeconds(29.9, 0.1, 30) - -0.2) < 1e-9);
  assert.ok(Math.abs(driftSeconds(0.1, 29.9, 30) - 0.2) < 1e-9);
});

test("resync only above the threshold", () => {
  assert.equal(shouldResync(10.1, 10, 30), false);
  assert.equal(shouldResync(10.3, 10, 30), true);
  assert.equal(shouldResync(10.3, 10, 30, 0.5), false);
});

test("unknown duration still compares directly", () => {
  assert.equal(driftSeconds(5, 2, 0), 3);
  assert.equal(shouldResync(5, 2, NaN), true);
});
