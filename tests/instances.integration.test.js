const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, sleep } = require("./helpers/server");
const { connect, registerScreen, mobileSync } = require("./helpers/ws");

let server;
before(async () => {
  server = await startServer({
    totems: { camp: { video: "camp_video.mp4", audio: "camp_audio.mp3" } },
    media: ["camp_video.mp4", "camp_audio.mp3", "outro.mp4", "novo_audio.mp3"],
  });
});
after(() => server.stop());

test("two screens of the same campaign keep separate sessions", async () => {
  const a = await registerScreen(server.wsBase, "camp", { instance: "inst-a", currentTime: 5 });
  const b = await registerScreen(server.wsBase, "camp", { instance: "inst-b", currentTime: 20 });
  try {
    assert.equal(a.session.instance, "inst-a");
    assert.equal(b.session.instance, "inst-b");

    const now = Date.now() / 1000;
    const syncA = (await mobileSync(server.wsBase, "camp", "inst-a")).sync;
    const syncB = (await mobileSync(server.wsBase, "camp", "inst-b")).sync;

    assert.equal(syncA.instance, "inst-a");
    assert.equal(syncB.instance, "inst-b");
    assert.ok(Math.abs(syncA.start_time - (now - 5)) < 1, "A keeps its own timeline");
    assert.ok(Math.abs(syncB.start_time - (now - 20)) < 1, "B keeps its own timeline");
    assert.equal(syncA.audio, "/media/camp_audio.mp3", "audio comes from the campaign");
  } finally {
    a.close();
    b.close();
  }
});

test("mobile_connected goes only to the scanned screen", async () => {
  const a = await registerScreen(server.wsBase, "camp", { instance: "notify-a" });
  const b = await registerScreen(server.wsBase, "camp", { instance: "notify-b" });
  try {
    await mobileSync(server.wsBase, "camp", "notify-a");
    await a.next("mobile_connected", 1500);
    await sleep(300);
    assert.equal(b.received("mobile_connected"), false);
  } finally {
    a.close();
    b.close();
  }
});

test("phone without instance (printed/legacy QR) follows the newest screen", async () => {
  const older = await registerScreen(server.wsBase, "camp", { instance: "legacy-old" });
  const newer = await registerScreen(server.wsBase, "camp", { instance: "legacy-new" });
  try {
    const { sync } = await mobileSync(server.wsBase, "camp");
    assert.equal(sync.instance, "legacy-new");
  } finally {
    older.close();
    newer.close();
  }
});

test("unknown instance or campaign closes the phone socket with 4004", async () => {
  assert.equal((await mobileSync(server.wsBase, "camp", "does-not-exist")).code, 4004);
  assert.equal((await mobileSync(server.wsBase, "nope")).code, 4004);
});

test("screen without instance parameter uses the default instance", async () => {
  const s = await registerScreen(server.wsBase, "camp");
  try {
    assert.equal(s.session.instance, "default");
  } finally {
    s.close();
  }
});

test("drift checks use the timeline of the phone's own screen", async () => {
  const a = await registerScreen(server.wsBase, "camp", { instance: "drift-a", currentTime: 3 });
  const b = await registerScreen(server.wsBase, "camp", { instance: "drift-b", currentTime: 17 });
  const drift = await connect(`${server.wsBase}/ws/drift/camp?instance=drift-b`);
  try {
    const check = await drift.next("drift_check", 3500);
    const syncA = (await mobileSync(server.wsBase, "camp", "drift-a")).sync;
    const syncB = (await mobileSync(server.wsBase, "camp", "drift-b")).sync;
    assert.equal(check.start_time, syncB.start_time, "drift follows drift-b");
    assert.notEqual(check.start_time, syncA.start_time, "not drift-a's timeline");
  } finally {
    drift.close();
    a.close();
    b.close();
  }
});

test("admin shows open screens and phones per campaign", async () => {
  const cookie = await server.login();
  const totems = async () =>
    (await (await fetch(`${server.base}/api/totems`, { headers: { Cookie: cookie } })).json()).find(t => t.id === "camp");

  const a = await registerScreen(server.wsBase, "camp", { instance: "admin-a" });
  const b = await registerScreen(server.wsBase, "camp", { instance: "admin-b" });
  const phone = await connect(`${server.wsBase}/ws/drift/camp?instance=admin-a`);
  try {
    await sleep(200);
    let t = await totems();
    assert.equal(t.is_online, true);
    assert.equal(t.instances, 2);
    assert.equal(t.mobile_count, 1);

    b.close();
    await sleep(300);
    t = await totems();
    assert.equal(t.instances, 1);
  } finally {
    phone.close();
    a.close();
  }
});

test("admin video change reaches every open screen of the campaign", async () => {
  const cookie = await server.login();
  const a = await registerScreen(server.wsBase, "camp", { instance: "bc-a" });
  const b = await registerScreen(server.wsBase, "camp", { instance: "bc-b" });
  try {
    // Registration already sends the current video; wait for it before clearing
    await a.next("change_video");
    await b.next("change_video");
    a.messages.length = 0;
    b.messages.length = 0;
    const res = await fetch(`${server.base}/api/totem/camp/config`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ video: "outro.mp4", audio: "camp_audio.mp3" }),
    });
    assert.equal(res.status, 200);
    assert.equal((await a.next("change_video")).filename, "outro.mp4");
    assert.equal((await b.next("change_video")).filename, "outro.mp4");
  } finally {
    a.close();
    b.close();
  }
});
