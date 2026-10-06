const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");
const { startServer } = require("./helpers/server");

// Opens a screen socket pretending to come from `ip` (via X-Forwarded-For).
// Resolves "ok" once the session is created, or the close code if rejected.
function openScreen(wsBase, campaign, instance, ip) {
  return new Promise(resolve => {
    const ws = new WebSocket(`${wsBase}/ws/screen/${campaign}?instance=${instance}`, {
      headers: { "X-Forwarded-For": ip },
    });
    ws.on("open", () => ws.send(JSON.stringify({ current_time: 0, duration: 30, drift_enabled: true })));
    ws.on("message", raw => {
      if (JSON.parse(raw).type === "session_created") resolve({ result: "ok", ws });
    });
    ws.on("close", code => resolve({ result: code, ws }));
    ws.on("error", () => {});
  });
}

describe("per-IP limit", () => {
  let server;
  before(async () => {
    server = await startServer({
      totems: { camp: { video: "v.mp4", audio: "a.mp3" } },
      env: { TRUST_PROXY: "1", MAX_SCREENS_PER_IP: "2", MAX_INSTANCES_PER_CAMPAIGN: "100" },
    });
  });
  after(() => server.stop());

  test("a third screen from the same IP is rejected with 4029", async () => {
    const a = await openScreen(server.wsBase, "camp", "ip-a", "10.0.0.1");
    const b = await openScreen(server.wsBase, "camp", "ip-b", "10.0.0.1");
    const c = await openScreen(server.wsBase, "camp", "ip-c", "10.0.0.1");
    const other = await openScreen(server.wsBase, "camp", "ip-d", "10.0.0.2");
    try {
      assert.equal(a.result, "ok");
      assert.equal(b.result, "ok");
      assert.equal(c.result, 4029);
      assert.equal(other.result, "ok", "other IPs are not affected");
    } finally {
      [a, b, c, other].forEach(s => s.ws.close());
    }
  });

  test("closing a screen frees a slot for that IP", async () => {
    const a = await openScreen(server.wsBase, "camp", "free-a", "10.0.0.9");
    const b = await openScreen(server.wsBase, "camp", "free-b", "10.0.0.9");
    b.ws.close();
    await new Promise(r => setTimeout(r, 200));
    const c = await openScreen(server.wsBase, "camp", "free-c", "10.0.0.9");
    try {
      assert.equal(c.result, "ok");
    } finally {
      a.ws.close();
      c.ws.close();
    }
  });
});

describe("per-campaign limit", () => {
  let server;
  before(async () => {
    server = await startServer({
      totems: { camp: { video: "v.mp4", audio: "a.mp3" } },
      env: { TRUST_PROXY: "1", MAX_SCREENS_PER_IP: "100", MAX_INSTANCES_PER_CAMPAIGN: "2" },
    });
  });
  after(() => server.stop());

  test("a campaign accepts at most N open screens, but a known instance can reconnect", async () => {
    const a = await openScreen(server.wsBase, "camp", "c-a", "10.1.0.1");
    const b = await openScreen(server.wsBase, "camp", "c-b", "10.1.0.2");
    const c = await openScreen(server.wsBase, "camp", "c-c", "10.1.0.3");
    const again = await openScreen(server.wsBase, "camp", "c-a", "10.1.0.1"); // same instance id
    try {
      assert.equal(a.result, "ok");
      assert.equal(b.result, "ok");
      assert.equal(c.result, 4029);
      assert.equal(again.result, "ok");
    } finally {
      [a, b, c, again].forEach(s => s.ws.close());
    }
  });
});
