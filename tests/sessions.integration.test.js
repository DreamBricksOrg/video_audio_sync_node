// Admin sessions are revocable: "Sair" kills the session itself (a copied
// cookie stops working) and "Desconectar outros aparelhos" ends every other one.
const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, sleep } = require("./helpers/server");
const { startFakeS3 } = require("./helpers/fake-s3");

const get = (server, cookie, p = "/api/session") => fetch(server.base + p, { headers: { Cookie: cookie }, redirect: "manual" });
const post = (server, cookie, p) => fetch(server.base + p, { method: "POST", headers: { Cookie: cookie } });

describe("local mode", () => {
  let server;
  before(async () => { server = await startServer(); });
  after(() => server.stop());

  test("a session works until logout, then the same cookie is rejected", async () => {
    const cookie = await server.login();
    assert.equal((await get(server, cookie)).status, 200);
    assert.equal((await post(server, cookie, "/api/logout")).status, 200);
    assert.equal((await get(server, cookie)).status, 401, "copied cookie no longer works");
    assert.equal((await get(server, cookie, "/admin")).status, 302);
  });

  test("logging out one device keeps the others logged in", async () => {
    const a = await server.login();
    const b = await server.login();
    await post(server, a, "/api/logout");
    assert.equal((await get(server, b)).status, 200);
  });

  test("disconnect others ends every session but the current one", async () => {
    const mine = await server.login();
    const other1 = await server.login();
    const other2 = await server.login();
    const before = await (await get(server, mine, "/api/sessions")).json();
    assert.ok(before.count >= 3);

    const r = await post(server, mine, "/api/sessions/revoke-others");
    assert.equal(r.status, 200);
    assert.ok((await r.json()).revoked >= 2);
    assert.equal((await get(server, other1)).status, 401);
    assert.equal((await get(server, other2)).status, 401);
    assert.equal((await get(server, mine)).status, 200);
    assert.equal((await (await get(server, mine, "/api/sessions")).json()).count, 1);
  });

  test("forged or old-style cookies are rejected", async () => {
    assert.equal((await get(server, "db_admin=dGVzdA.abc")).status, 401);
    assert.equal((await get(server, "db_admin=")).status, 401);
  });
});

describe("servers sharing a bucket", () => {
  const s3Env = endpoint => ({
    S3_BUCKET: "midia", S3_PREFIX: "prod", S3_REGION: "us-east-1", S3_ENDPOINT: endpoint,
    AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test", CONFIG_REFRESH_MS: "200",
  });
  let s3, a, b;
  before(async () => {
    s3 = await startFakeS3();
    a = await startServer({ env: s3Env(s3.endpoint) });
    b = await startServer({ env: s3Env(s3.endpoint) });
  });
  after(() => { a.stop(); b.stop(); s3.stop(); });

  test("a login on one server is accepted right away by the other", async () => {
    const cookie = await a.login();
    assert.equal((await get(b, cookie)).status, 200);
  });

  test("a logout on one server ends the session on the other too", async () => {
    const cookie = await a.login();
    assert.equal((await get(b, cookie)).status, 200);
    await post(a, cookie, "/api/logout");
    let status;
    for (const end = Date.now() + 3000; Date.now() < end; await sleep(100)) {
      status = (await get(b, cookie)).status;
      if (status === 401) break;
    }
    assert.equal(status, 401);
  });

  test("the bucket keeps only hashes, never the cookie value", async () => {
    const cookie = await a.login();
    const stored = s3.objects.get("midia/prod/sessions.json").body.toString();
    assert.ok(!stored.includes(cookie.split("=")[1]));
  });
});
