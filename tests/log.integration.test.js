// LOG_FORMAT=json: every line the server prints is JSON. SENTRY_DSN: errors
// reach Sentry (here a fake Sentry server).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { startServer, sleep } = require("./helpers/server");
const { startFakeS3 } = require("./helpers/fake-s3");

test("LOG_FORMAT=json prints one JSON object per line, startup banner included", async () => {
  const server = await startServer({ env: { LOG_FORMAT: "json" } });
  try {
    const cookie = await server.login();
    assert.ok(cookie);
    await sleep(100);
    const lines = server.output().split("\n").filter(Boolean);
    assert.ok(lines.length > 5);
    const entries = lines.map(l => JSON.parse(l));
    assert.ok(entries.every(e => e.time && e.level && e.scope && typeof e.msg === "string"));
    assert.ok(entries.some(e => e.scope === "Server" && /running on/.test(e.msg)));
    assert.ok(entries.some(e => e.scope === "Auth" && /logged in/.test(e.msg)));
  } finally {
    server.stop();
  }
});

test("with SENTRY_DSN, an error (S3 unreachable) is sent to Sentry once", async () => {
  const envelopes = [];
  const sentry = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      envelopes.push({ url: req.url, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise(r => sentry.listen(0, r));
  const dsn = `http://publickey@127.0.0.1:${sentry.address().port}/42`;

  const s3 = await startFakeS3();
  const server = await startServer({
    env: {
      SENTRY_DSN: dsn,
      S3_BUCKET: "midia", S3_PREFIX: "prod", S3_REGION: "us-east-1", S3_ENDPOINT: s3.endpoint,
      AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test", CONFIG_REFRESH_MS: "200",
    },
  });
  try {
    assert.match(server.output(), /Sentry on/);
    s3.stop();
    // Config and sessions both fail with the same S3 error; Sentry may merge
    // them (its Dedupe), so expect one or two reports — and no more after that
    const refreshErrors = () => envelopes.filter(e => /refresh failed/i.test(e.body));
    for (const end = Date.now() + 10000; Date.now() < end && !refreshErrors().length; await sleep(200));
    assert.ok(refreshErrors().length >= 1, "first failure reported");
    assert.match(refreshErrors()[0].url, /\/api\/42\/envelope/);
    await sleep(1500);
    const settled = refreshErrors().length;
    assert.ok(settled <= 2, `one report per kind of failure, got ${settled}`);
    await sleep(1500);
    assert.equal(refreshErrors().length, settled, "repeats are warnings, not new reports");
  } finally {
    server.stop();
    sentry.close();
    sentry.closeAllConnections();
  }
});
