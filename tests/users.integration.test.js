// Several admin users: Admin (everything) and Editor (campaigns, media, links,
// stats — not users, activity log or "disconnect others"). The .env account is
// the main admin. Every action is in the activity log.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startServer } = require("./helpers/server");

let server, admin;
before(async () => {
  server = await startServer({ media: ["v.mp4", "a.mp3"] });
  admin = await server.login();
});
after(() => server.stop());

async function loginAs(username, password) {
  const res = await fetch(`${server.base}/api/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }),
  });
  const cookie = res.headers.get("set-cookie");
  return { status: res.status, cookie: cookie && cookie.split(";")[0] };
}
const call = async (cookie, method, p, body) => {
  const res = await fetch(server.base + p, {
    method, headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

test("the .env account is the main admin", async () => {
  const { body } = await call(admin, "GET", "/api/session");
  assert.deepEqual(body, { user: "test", name: "test", role: "admin", main: true });
  const users = await call(admin, "GET", "/api/users");
  assert.deepEqual(users.body.map(u => [u.name, u.role, u.main]), [["test", "admin", true]]);
});

test("an editor works with campaigns but not with users, the log or other sessions", async () => {
  assert.equal((await call(admin, "POST", "/api/users", { name: "ana", password: "senha-forte-1", role: "editor" })).status, 201);
  const users = await call(admin, "GET", "/api/users");
  const ana = users.body.find(u => u.name === "ana");
  assert.equal(ana.role, "editor");
  assert.equal(ana.hash, undefined, "never sends the hash");

  assert.equal((await loginAs("ana", "errada")).status, 401);
  const { cookie } = await loginAs("ana", "senha-forte-1");
  assert.deepEqual((await call(cookie, "GET", "/api/session")).body, { user: "ana", name: "ana", role: "editor", main: false });
  assert.equal((await call(cookie, "GET", "/api/totems")).status, 200);
  assert.equal((await call(cookie, "POST", "/api/totems", { id: "camp_ana", video: "v.mp4", audio: "a.mp3" })).status, 201);
  assert.equal((await call(cookie, "GET", "/api/stats?days=1")).status, 200);
  assert.equal((await call(cookie, "GET", "/api/users")).status, 403);
  assert.equal((await call(cookie, "POST", "/api/users", { name: "x", password: "12345678", role: "admin" })).status, 403);
  assert.equal((await call(cookie, "GET", "/api/audit")).status, 403);
  assert.equal((await call(cookie, "POST", "/api/sessions/revoke-others")).status, 403);
});

test("role changes apply right away; a new password or deletion ends the user's sessions", async () => {
  const { cookie } = await loginAs("ana", "senha-forte-1");
  assert.equal((await call(admin, "PATCH", "/api/users/ana", { role: "admin" })).status, 200);
  assert.equal((await call(cookie, "GET", "/api/users")).status, 200, "now an admin, same session");

  assert.equal((await call(admin, "PATCH", "/api/users/ana", { password: "outra-senha-2" })).status, 200);
  assert.equal((await call(cookie, "GET", "/api/session")).status, 401, "old session ended");
  const again = await loginAs("ana", "outra-senha-2");
  assert.equal(again.status, 200);

  assert.equal((await call(admin, "DELETE", "/api/users/ana")).status, 200);
  assert.equal((await call(again.cookie, "GET", "/api/session")).status, 401);
  assert.equal((await loginAs("ana", "outra-senha-2")).status, 401);
});

test("validation and protections", async () => {
  assert.equal((await call(admin, "POST", "/api/users", { name: "bia", password: "curta", role: "editor" })).status, 400);
  assert.equal((await call(admin, "POST", "/api/users", { name: "com espaço", password: "senha-forte-1", role: "editor" })).status, 400);
  assert.equal((await call(admin, "POST", "/api/users", { name: "bia", password: "senha-forte-1", role: "dono" })).status, 400);
  assert.equal((await call(admin, "POST", "/api/users", { name: "test", password: "senha-forte-1", role: "editor" })).status, 409);
  assert.equal((await call(admin, "PATCH", "/api/users/test", { role: "editor" })).status, 400, "main account is edited in .env");
  assert.equal((await call(admin, "DELETE", "/api/users/test")).status, 400);
  assert.equal((await call(admin, "DELETE", "/api/users/nao_existe")).status, 404);

  await call(admin, "POST", "/api/users", { name: "caio", password: "senha-forte-1", role: "admin" });
  const caio = (await loginAs("caio", "senha-forte-1")).cookie;
  assert.equal((await call(caio, "DELETE", "/api/users/caio")).status, 400, "can't delete yourself");
});

test("passwords are stored hashed", () => {
  const stored = fs.readFileSync(path.join(path.dirname(server.totemsFile), "users.json"), "utf8");
  assert.ok(!stored.includes("senha-forte-1"));
  assert.match(stored, /scrypt\$/);
});

test("the activity log has who did what, newest first, without passwords", async () => {
  const res = await call(admin, "GET", "/api/audit");
  assert.equal(res.status, 200);
  const entries = res.body.entries;
  assert.ok(entries.length >= 6);
  assert.ok(entries[0].time >= entries[entries.length - 1].time);
  const has = (user, action, target) => entries.some(e => e.user === user && e.action === action && (!target || e.target === target));
  assert.ok(has("ana", "Criou campanha", "camp_ana"));
  assert.ok(has("test", "Criou usuário", "ana"));
  assert.ok(has("test", "Editou usuário", "ana"));
  assert.ok(has("test", "Excluiu usuário", "ana"));
  assert.ok(has("ana", "Entrou"));
  assert.ok(!JSON.stringify(res.body).includes("senha-forte-1"));
  assert.ok(!JSON.stringify(res.body).includes("outra-senha-2"));
});
