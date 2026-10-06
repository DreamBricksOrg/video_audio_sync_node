const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { startServer } = require("./helpers/server");

let server;
before(async () => { server = await startServer({ totems: { camp: { video: "v.mp4", audio: "a.mp3" } } }); });
after(() => server.stop());

test("server starts with the temporary totems file", async () => {
  const res = await fetch(`${server.base}/health`);
  assert.equal(res.status, 200);

  const cookie = await server.login();
  const totems = await (await fetch(`${server.base}/api/totems`, { headers: { Cookie: cookie } })).json();
  assert.deepEqual(totems.map(t => t.id), ["camp"]);
});

test("admin writes go to TOTEMS_FILE, not the project totems.json", async () => {
  const cookie = await server.login();
  const res = await fetch(`${server.base}/api/totems`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ id: "smoke_new" }),
  });
  assert.equal(res.status, 201);
  assert.ok(JSON.parse(fs.readFileSync(server.totemsFile, "utf8")).smoke_new);
});
