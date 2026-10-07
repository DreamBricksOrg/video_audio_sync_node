// Two servers sharing one bucket/prefix (e.g. a dev machine and AWS) must see
// the same campaigns config: no more per-server totems.json drifting apart.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, sleep } = require("./helpers/server");
const { startFakeS3 } = require("./helpers/fake-s3");
const { registerScreen } = require("./helpers/ws");

const s3Env = endpoint => ({
  S3_BUCKET: "midia",
  S3_PREFIX: "prod",
  S3_REGION: "us-east-1",
  S3_ENDPOINT: endpoint,
  AWS_ACCESS_KEY_ID: "test",
  AWS_SECRET_ACCESS_KEY: "test",
  CONFIG_REFRESH_MS: "200",
});

let s3, a, b, cookieA, cookieB;
before(async () => {
  s3 = await startFakeS3();
  for (const f of ["v1.mp4", "v2.mp4", "a.mp3"]) s3.objects.set(`midia/prod/${f}`, { body: Buffer.from(f) });
  // A starts first with a local config → it seeds the bucket
  a = await startServer({ totems: { camp: { video: "v1.mp4", audio: "a.mp3" } }, env: s3Env(s3.endpoint) });
  // B has a different (stale) local file, which must be ignored
  b = await startServer({ totems: { stale: { video: "old.mp4" } }, env: s3Env(s3.endpoint) });
  cookieA = await a.login();
  cookieB = await b.login();
});
after(() => {
  a.stop();
  b.stop();
  s3.stop();
});

const totems = async (server, cookie) =>
  (await (await fetch(`${server.base}/api/totems`, { headers: { Cookie: cookie } })).json());
const post = (server, cookie, p, body) => fetch(server.base + p, {
  method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const waitFor = async (check, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await check()) return true;
  return false;
};

test("the config lives in the bucket and both servers read it", async () => {
  const stored = JSON.parse(s3.objects.get("midia/prod/totems.json").body);
  assert.deepEqual(Object.keys(stored), ["camp"]);
  assert.deepEqual((await totems(b, cookieB)).map(t => t.id), ["camp"], "B ignores its stale local file");
});

test("a change on one server reaches the other and its open screens", async () => {
  const screen = await registerScreen(b.wsBase, "camp", { instance: "on-b" });
  try {
    await screen.next("change_video");
    screen.messages.length = 0;

    const r = await post(a, cookieA, "/api/totem/camp/config", { video: "v2.mp4", audio: "a.mp3" });
    assert.equal(r.status, 200);

    assert.equal((await screen.next("change_video", 3000)).filename, "v2.mp4", "screen on B switches");
    assert.ok(await waitFor(async () => (await totems(b, cookieB))[0].video === "v2.mp4"), "B's admin shows it");
  } finally {
    screen.close();
  }
});

test("simultaneous edits on both servers are both kept", async () => {
  const [ra, rb] = await Promise.all([
    post(a, cookieA, "/api/totems", { id: "from_a", video: "v1.mp4" }),
    post(b, cookieB, "/api/totems", { id: "from_b", video: "v2.mp4" }),
  ]);
  assert.equal(ra.status, 201);
  assert.equal(rb.status, 201);
  const stored = JSON.parse(s3.objects.get("midia/prod/totems.json").body);
  assert.ok(stored.from_a && stored.from_b && stored.camp, `bucket has all: ${Object.keys(stored)}`);
  assert.ok(await waitFor(async () => (await totems(a, cookieA)).some(t => t.id === "from_b")));
});

test("renaming a file on one server updates the config for everyone", async () => {
  const r = await fetch(`${a.base}/api/media/v2.mp4`, {
    method: "PATCH", headers: { Cookie: cookieA, "Content-Type": "application/json" },
    body: JSON.stringify({ filename: "v2-final.mp4" }),
  });
  assert.equal(r.status, 200);
  assert.ok(await waitFor(async () => {
    const list = await totems(b, cookieB);
    return list.find(t => t.id === "camp").video === "v2-final.mp4";
  }), "B sees the new name (no more 403 for a stale name)");
});
