// Self sign-up: someone with an @dreambricks.com.br e-mail logs in with the
// invite password (DEFAULT_USER_PASSWORD) the first time, then creates their
// own user (name + letters-and-numbers password) and becomes an Editor.
const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers/server");

const INVITE = "convite123#x";

async function post(server, p, body, cookie) {
  const res = await fetch(server.base + p, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  const setCookie = res.headers.get("set-cookie");
  return { status: res.status, body: await res.json().catch(() => ({})), cookie: setCookie && setCookie.split(";")[0] };
}
const get = async (server, p, cookie) => {
  const res = await fetch(server.base + p, { headers: cookie ? { Cookie: cookie } : {} });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

describe("with an invite password", () => {
  let server, admin;
  before(async () => {
    server = await startServer({ env: { DEFAULT_USER_PASSWORD: INVITE } });
    admin = await server.login();
  });
  after(() => server.stop());

  let token;
  test("first login with the invite password leads to sign-up, without a session", async () => {
    const r = await post(server, "/api/login", { username: "Nova.Pessoa@DreamBricks.com.br", password: INVITE });
    assert.equal(r.status, 200);
    assert.equal(r.body.signup, true);
    assert.equal(r.body.email, "nova.pessoa@dreambricks.com.br");
    assert.ok(r.body.token);
    assert.ok(!r.cookie || !/db_admin=[^;]{10,}/.test(r.cookie), "no session yet");
    token = r.body.token;
    assert.equal((await fetch(`${server.base}/signup`)).status, 200);
  });

  test("the new password must have letters and numbers, 8+, and not be the invite", async () => {
    for (const password of ["abc123", "somenteletras", "1234567890", INVITE]) {
      const r = await post(server, "/api/signup", { token, name: "Nova Pessoa", password });
      assert.equal(r.status, 400, `${password} should be refused`);
    }
    assert.equal((await post(server, "/api/signup", { token, name: " ", password: "senha123abc" })).status, 400);
    assert.equal((await post(server, "/api/signup", { token: "forjado.abc", name: "X", password: "senha123abc" })).status, 400);
  });

  test("sign-up creates an Editor and logs in", async () => {
    const r = await post(server, "/api/signup", { token, name: "Nova Pessoa", password: "senha123abc" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.cookie);
    const session = await get(server, "/api/session", r.cookie);
    assert.deepEqual(session.body, { user: "nova.pessoa@dreambricks.com.br", name: "Nova Pessoa", role: "editor", main: false });
  });

  test("afterwards: own password works (any case), the invite doesn't, the token is spent", async () => {
    assert.equal((await post(server, "/api/login", { username: "NOVA.PESSOA@dreambricks.com.br", password: "senha123abc" })).status, 200);
    const again = await post(server, "/api/login", { username: "nova.pessoa@dreambricks.com.br", password: INVITE });
    assert.equal(again.status, 401);
    assert.equal(again.body.signup, undefined);
    assert.equal((await post(server, "/api/signup", { token, name: "Outra", password: "senha456abc" })).status, 409);
  });

  test("only the configured domain; other e-mails get the usual error", async () => {
    assert.equal((await post(server, "/api/login", { username: "alguem@gmail.com", password: INVITE })).status, 401);
    assert.equal((await post(server, "/api/login", { username: "x@dreambricks.com.br.evil.com", password: INVITE })).status, 401);
    assert.equal((await post(server, "/api/login", { username: "x@dreambricks.com.br", password: "" })).status, 401);
  });

  test("admins see the new user with their name; the activity log has the sign-up", async () => {
    const users = await get(server, "/api/users", admin);
    const u = users.body.find(x => x.name === "nova.pessoa@dreambricks.com.br");
    assert.equal(u.displayName, "Nova Pessoa");
    assert.equal(u.role, "editor");
    const audit = await get(server, "/api/audit", admin);
    assert.ok(audit.body.entries.some(e => e.user === "nova.pessoa@dreambricks.com.br" && e.action === "Criou a própria conta"));
  });
});

describe("without an invite password", () => {
  let server;
  before(async () => { server = await startServer(); });
  after(() => server.stop());

  test("sign-up is off", async () => {
    assert.equal((await post(server, "/api/login", { username: "a@dreambricks.com.br", password: "" })).status, 401);
    assert.equal((await post(server, "/api/signup", { token: "x.y", name: "A", password: "senha123abc" })).status, 404);
  });
});
