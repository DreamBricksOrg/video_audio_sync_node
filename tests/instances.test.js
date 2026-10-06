const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createInstanceRegistry, DEFAULT_INSTANCE } = require("../lib/instances");

// Fake clock in seconds, so tests control time
function setup(opts = {}) {
  let t = 1000;
  const clock = { now: () => t, advance: s => (t += s) };
  return { reg: createInstanceRegistry({ now: clock.now, graceSeconds: 60, ...opts }), clock };
}
const fakeWs = () => ({ id: Math.random() });

test("each instance of a campaign has its own session", () => {
  const { reg } = setup();
  const a = reg.register("camp", "a", fakeWs());
  const b = reg.register("camp", "b", fakeWs());
  reg.startSession(a, { current_time: 5, duration: 30, drift_enabled: true });
  reg.startSession(b, { current_time: 20, duration: 30 });

  assert.equal(reg.resolve("camp", "a").session.start_time, 995);
  assert.equal(reg.resolve("camp", "b").session.start_time, 980);
  assert.equal(reg.resolve("camp", "a").session.drift_enabled, true);
});

test("invalid or missing instance ids fall back to the default instance", () => {
  const { reg } = setup();
  assert.equal(reg.register("camp", undefined, fakeWs()).id, DEFAULT_INSTANCE);
  assert.equal(reg.register("camp", "bad id!", fakeWs()).id, DEFAULT_INSTANCE);
  assert.equal(reg.register("camp", "ok-ID_123", fakeWs()).id, "ok-ID_123");
});

test("resolve without instance returns the most recent online instance with a session", () => {
  const { reg } = setup();
  const a = reg.register("camp", "a", fakeWs());
  reg.startSession(a, { current_time: 0 });
  const b = reg.register("camp", "b", fakeWs());
  reg.startSession(b, { current_time: 0 });
  reg.register("camp", "c", fakeWs()); // no session yet

  assert.equal(reg.resolve("camp").id, "b");
  reg.disconnect(b, b.ws);
  assert.equal(reg.resolve("camp").id, "a");
});

test("resolve returns null for unknown campaign, unknown instance or no session", () => {
  const { reg } = setup();
  reg.register("camp", "a", fakeWs());
  assert.equal(reg.resolve("nope"), null);
  assert.equal(reg.resolve("camp", "zzz"), null);
  assert.equal(reg.resolve("camp", "a"), null);
});

test("updatePosition recalculates start_time from the server clock", () => {
  const { reg, clock } = setup();
  const a = reg.register("camp", "a", fakeWs());
  reg.startSession(a, { current_time: 0, duration: 30 });
  clock.advance(10);
  reg.updatePosition(a, 12);
  assert.equal(a.session.start_time, 998);
});

test("reconnecting with the same id reuses the instance and its phones", () => {
  const { reg } = setup();
  const ws1 = fakeWs();
  const a = reg.register("camp", "a", ws1);
  a.drifts.add("phone");
  reg.disconnect(a, ws1);
  const again = reg.register("camp", "a", fakeWs());
  assert.equal(again, a);
  assert.equal(again.disconnectedAt, null);
  assert.equal(again.drifts.size, 1);
});

test("disconnect from an old socket does not affect a newer one", () => {
  const { reg } = setup();
  const ws1 = fakeWs();
  const ws2 = fakeWs();
  const a = reg.register("camp", "a", ws1);
  reg.register("camp", "a", ws2);
  reg.disconnect(a, ws1);
  assert.equal(a.ws, ws2);
  assert.equal(reg.online("camp").length, 1);
});

test("online and stats count only connected screens; phones are summed", () => {
  const { reg } = setup();
  const a = reg.register("camp", "a", fakeWs());
  const b = reg.register("camp", "b", fakeWs());
  a.drifts.add("p1");
  a.drifts.add("p2");
  b.drifts.add("p3");
  reg.disconnect(b, b.ws);

  assert.deepEqual(reg.online("camp").map(i => i.id), ["a"]);
  assert.deepEqual(reg.stats("camp"), { instances: 1, mobiles: 3 });
  assert.deepEqual(reg.stats("nope"), { instances: 0, mobiles: 0 });
  assert.deepEqual(reg.campaignsOnline(), ["camp"]);
});

test("sweep removes instances disconnected longer than the grace period without phones", () => {
  const { reg, clock } = setup();
  const a = reg.register("camp", "a", fakeWs());
  const b = reg.register("camp", "b", fakeWs());
  b.drifts.add("phone");
  reg.disconnect(a, a.ws);
  reg.disconnect(b, b.ws);

  clock.advance(30);
  assert.equal(reg.sweep(), 0);
  clock.advance(31);
  assert.equal(reg.sweep(), 1);
  assert.equal(reg.get("camp", "a"), null);
  assert.ok(reg.get("camp", "b"));

  b.drifts.clear();
  assert.equal(reg.sweep(), 1);
  assert.deepEqual(reg.totals(), { instances: 0, online: 0, mobiles: 0 });
});
