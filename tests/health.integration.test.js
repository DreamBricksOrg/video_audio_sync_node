// /health for uptime monitors: 200 when everything works, 503 with the reason
// when the media library, the campaigns config or the sessions storage fails.
const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, sleep } = require("./helpers/server");
const { startFakeS3 } = require("./helpers/fake-s3");

describe("local mode", () => {
  let server;
  before(async () => { server = await startServer(); });
  after(() => server.stop());

  test("everything ok", async () => {
    const res = await fetch(`${server.base}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "ok");
    assert.deepEqual(body.checks, { media: { ok: true }, config: { ok: true }, sessions: { ok: true } });
    assert.match(body.version, /^\d+\.\d+\.\d+/);
    assert.ok(body.started_at);
  });
});

describe("S3 down", () => {
  let s3, server;
  before(async () => {
    s3 = await startFakeS3();
    server = await startServer({
      env: {
        S3_BUCKET: "midia", S3_PREFIX: "prod", S3_REGION: "us-east-1", S3_ENDPOINT: s3.endpoint,
        AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test", CONFIG_REFRESH_MS: "200",
      },
    });
  });
  after(() => { server.stop(); s3.stop(); });

  test("503 with the failing checks; the first failure is an error, repeats are warnings", async () => {
    assert.equal((await fetch(`${server.base}/health`)).status, 200);
    s3.stop();
    // Sessions and config both refresh every 200ms; wait for the config one
    let res, body;
    for (const end = Date.now() + 8000; Date.now() < end; await sleep(200)) {
      res = await fetch(`${server.base}/health`);
      body = await res.json();
      if (!body.checks.config.ok) break;
    }
    assert.equal(res.status, 503);
    assert.equal(body.status, "degraded");
    assert.equal(body.checks.config.ok, false);
    assert.ok(body.checks.config.error);
    await sleep(800);
    const errors = server.output().split("\n").filter(l => l.includes("[Config] Refresh failed"));
    assert.ok(errors.length >= 2, "keeps trying");
  });
});
