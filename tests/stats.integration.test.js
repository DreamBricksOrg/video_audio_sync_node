// Admin statistics: screens, scans, phones listening and listening time per
// campaign per day, saved to one file per day and exported as CSV.
const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const WebSocket = require("ws");
const { startServer, sleep } = require("./helpers/server");
const { startFakeS3 } = require("./helpers/fake-s3");
const { registerScreen, mobileSync } = require("./helpers/ws");

const getJson = async (server, cookie, p) => (await fetch(server.base + p, { headers: { Cookie: cookie } })).json();

async function listenFor(server, campaign, instance, ms) {
  const ws = new WebSocket(`${server.wsBase}/ws/drift/${campaign}?instance=${instance}`);
  await new Promise(r => ws.once("open", r));
  await sleep(ms);
  ws.close();
  await sleep(100);
}

async function exercise(server) {
  const a = await registerScreen(server.wsBase, "camp", { instance: "tela-a", site: "loja.com.br" });
  const b = await registerScreen(server.wsBase, "camp", { instance: "tela-b", site: "" });
  const junk = await registerScreen(server.wsBase, "nao_existe", { instance: "x", site: "spam.com" });
  // Reconnecting the same instance is not a new screen
  a.close();
  await sleep(100);
  const again = await registerScreen(server.wsBase, "camp", { instance: "tela-a", site: "loja.com.br" });
  await mobileSync(server.wsBase, "camp", "tela-a");
  await mobileSync(server.wsBase, "camp", "tela-b");
  await mobileSync(server.wsBase, "nao_existe", "x");
  await listenFor(server, "camp", "tela-a", 1200);
  [b, junk, again].forEach(s => s.close());
}

describe("local mode", () => {
  let server, cookie;
  before(async () => {
    server = await startServer({ totems: { camp: { video: "v.mp4", audio: "a.mp3" } }, media: ["v.mp4", "a.mp3"] });
    cookie = await server.login();
    await exercise(server);
  });
  after(() => server.stop());

  test("counts today's activity for configured campaigns only", async () => {
    const { days, timezone } = await getJson(server, cookie, "/api/stats?days=7");
    assert.equal(timezone, "America/Sao_Paulo");
    assert.equal(days.length, 7);
    const today = days[days.length - 1];
    assert.deepEqual(Object.keys(today.campaigns), ["camp"]);
    const c = today.campaigns.camp;
    assert.equal(c.screens, 2);
    assert.equal(c.scans, 2);
    assert.equal(c.listeners, 1);
    assert.equal(c.listens, 1);
    assert.ok(c.listen_seconds >= 1 && c.listen_seconds <= 3, `listened ~1s, got ${c.listen_seconds}`);
    assert.deepEqual(c.sites, { "loja.com.br": 1, "(direto)": 1 });
  });

  test("saved as one file per day next to totems.json", async () => {
    const dir = path.join(path.dirname(server.totemsFile), "stats");
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
    assert.equal(files.length, 1);
    assert.match(files[0], /^\d{4}-\d{2}-\d{2}\.json$/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, files[0]))).camp.scans, 2);
  });

  test("CSV export", async () => {
    const res = await fetch(`${server.base}/api/stats.csv?days=1&campaign=camp`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
    assert.match(res.headers.get("content-disposition"), /attachment; filename="estatisticas-camp-/);
    const lines = (await res.text()).replace(/^\uFEFF/, "").trim().split("\r\n");
    assert.equal(lines.length, 2);
    assert.match(lines[1], /^\d{4}-\d{2}-\d{2};camp;2;2;1;\d+;/);
  });

  test("admin only", async () => {
    assert.equal((await fetch(`${server.base}/api/stats`)).status, 401);
    assert.equal((await fetch(`${server.base}/api/stats.csv`)).status, 401);
  });
});

describe("servers sharing a bucket", () => {
  const s3Env = endpoint => ({
    S3_BUCKET: "midia", S3_PREFIX: "prod", S3_REGION: "us-east-1", S3_ENDPOINT: endpoint,
    AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test", CONFIG_REFRESH_MS: "200",
  });
  let s3, a, b, cookie;
  before(async () => {
    s3 = await startFakeS3();
    for (const f of ["v.mp4", "a.mp3"]) s3.objects.set(`midia/prod/${f}`, { body: Buffer.from(f) });
    a = await startServer({ totems: { camp: { video: "v.mp4", audio: "a.mp3" } }, env: s3Env(s3.endpoint) });
    b = await startServer({ env: s3Env(s3.endpoint) });
    cookie = await a.login();
  });
  after(() => { a.stop(); b.stop(); s3.stop(); });

  test("both servers' counts add up in the bucket's day file", async () => {
    const sa = await registerScreen(a.wsBase, "camp", { instance: "on-a" });
    const sb = await registerScreen(b.wsBase, "camp", { instance: "on-b" });
    await mobileSync(a.wsBase, "camp", "on-a");
    await mobileSync(b.wsBase, "camp", "on-b");
    await mobileSync(b.wsBase, "camp", "on-b");
    sa.close();
    sb.close();
    // Reading on each server saves its own pending counts first
    await getJson(b, await b.login(), "/api/stats?days=1");
    const { days } = await getJson(a, cookie, "/api/stats?days=1");
    assert.equal(days[0].campaigns.camp.scans, 3);
    assert.equal(days[0].campaigns.camp.screens, 2);
    const key = [...s3.objects.keys()].find(k => k.startsWith("midia/prod/stats/"));
    assert.match(key, /^midia\/prod\/stats\/\d{4}-\d{2}-\d{2}\.json$/);
  });
});
