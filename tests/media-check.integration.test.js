const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers/server");

let server, cookie;
before(async () => {
  server = await startServer({
    totems: {
      ok: { video: "real.mp4", audio: "real.mp3" },
      broken: { video: "renamed-elsewhere.mp4", audio: "real.mp3" },
    },
    media: ["real.mp4", "real.mp3"],
  });
  cookie = await server.login();
});
after(() => server.stop());

const totems = async () =>
  (await (await fetch(`${server.base}/api/totems`, { headers: { Cookie: cookie } })).json());

const apply = (id, body) => fetch(`${server.base}/api/totem/${id}/config`, {
  method: "POST",
  headers: { Cookie: cookie, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

test("the totem list flags configured files that are not in the library", async () => {
  const list = await totems();
  assert.deepEqual(list.find(t => t.id === "ok").missing, []);
  assert.deepEqual(list.find(t => t.id === "broken").missing, ["renamed-elsewhere.mp4"]);
});

test("'Aplicar' refuses files that do not exist", async () => {
  let r = await apply("ok", { video: "nope.mp4", audio: "real.mp3" });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /Vídeo não encontrado: nope\.mp4/);

  r = await apply("ok", { video: "real.mp4", audio: "nope.mp3" });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /Áudio não encontrado: nope\.mp3/);

  const list = await totems();
  assert.equal(list.find(t => t.id === "ok").video, "real.mp4", "config unchanged after refusal");
});

test("fixing the broken totem clears the warning", async () => {
  const r = await apply("broken", { video: "real.mp4", audio: "real.mp3" });
  assert.equal(r.status, 200);
  assert.deepEqual((await totems()).find(t => t.id === "broken").missing, []);
});
