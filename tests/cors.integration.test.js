const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers/server");

const fromSite = origin => ({ headers: { Origin: origin } });

describe("default: no cross-origin access", () => {
  let server;
  before(async () => { server = await startServer(); });
  after(() => server.stop());

  test("no Access-Control-Allow-Origin on any route", async () => {
    for (const p of ["/health", "/media/x.mp3", "/api/totems", "/login"]) {
      const res = await fetch(server.base + p, fromSite("https://evil.example"));
      assert.equal(res.headers.get("access-control-allow-origin"), null, p);
    }
  });
});

describe("with CORS_ORIGINS", () => {
  let server;
  before(async () => {
    server = await startServer({ env: { CORS_ORIGINS: "https://site.example, https://outro.example" } });
  });
  after(() => server.stop());

  test("listed origins can read media and health", async () => {
    for (const p of ["/health", "/media/x.mp3"]) {
      const res = await fetch(server.base + p, fromSite("https://outro.example"));
      assert.equal(res.headers.get("access-control-allow-origin"), "https://outro.example", p);
      assert.match(res.headers.get("vary") || "", /Origin/);
    }
  });

  test("other origins get nothing", async () => {
    const res = await fetch(`${server.base}/health`, fromSite("https://evil.example"));
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });

  test("the admin API is never exposed cross-origin", async () => {
    const res = await fetch(`${server.base}/api/totems`, fromSite("https://site.example"));
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });

  test("preflight for media answers 204 with allowed methods", async () => {
    const res = await fetch(`${server.base}/media/x.mp3`, {
      method: "OPTIONS",
      headers: { Origin: "https://site.example", "Access-Control-Request-Method": "GET" },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "https://site.example");
    assert.match(res.headers.get("access-control-allow-methods"), /GET/);
  });
});
