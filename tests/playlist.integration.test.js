// Campaigns with several videos (each with its audio) and a schedule with a
// fallback campaign: what screens and phones receive.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");
const { startServer, sleep } = require("./helpers/server");
const { connect, registerScreen, mobileSync } = require("./helpers/ws");

const PAST = "2020-01-01T00:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";

let server, cookie;
before(async () => {
  server = await startServer({
    totems: {
      lista: { video: "v1.mp4", audio: "a1.mp3" },
      padrao: { video: "d.mp4", audio: "d.mp3", promo: { text: "Promo padrão", app: { label: "App" }, links: [] } },
    },
    media: ["v1.mp4", "v2.mp4", "d.mp4", "a1.mp3", "a2.mp3", "d.mp3"],
  });
  cookie = await server.login();
});
after(() => server.stop());

const call = async (method, p, body) => {
  const res = await fetch(server.base + p, {
    method, headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const totem = async id => (await call("GET", "/api/totems")).body.find(t => t.id === id);

const PLAYLIST = [{ video: "v1.mp4", audio: "a1.mp3" }, { video: "v2.mp4", audio: "a2.mp3" }];

test("a playlist reaches the open screens, in order, each video with its audio", async () => {
  const screen = await registerScreen(server.wsBase, "lista", { instance: "s1" });
  try {
    await screen.next("change_video");
    screen.messages.length = 0;
    const r = await call("POST", "/api/totem/lista/config", { playlist: PLAYLIST });
    assert.equal(r.status, 200);
    const msg = await screen.next("change_video");
    assert.deepEqual(msg.playlist.map(i => [i.video, i.url, i.audio]), [
      ["v1.mp4", "/media/v1.mp4", "/media/a1.mp3"],
      ["v2.mp4", "/media/v2.mp4", "/media/a2.mp3"],
    ]);
    assert.equal(msg.filename, "v1.mp4", "first item for older pages");
    assert.equal(msg.idle, false);
    const t = await totem("lista");
    assert.equal(t.playlist.length, 2);
    assert.equal(t.showing, "lista");
  } finally {
    screen.close();
  }
});

test("phones get each audio's start and length from the screen's video lengths", async () => {
  const screen = await registerScreen(server.wsBase, "lista", { instance: "s2" });
  try {
    screen.send({ current_time: 12, duration: 30, items: [10, 20], mode: "sync", drift_enabled: true });
    await sleep(100);
    const { sync } = await mobileSync(server.wsBase, "lista", "s2");
    assert.equal(sync.duration, 30);
    assert.deepEqual(sync.items, [
      { audio: "/media/a1.mp3", start: 0, duration: 10 },
      { audio: "/media/a2.mp3", start: 10, duration: 20 },
    ]);
    assert.equal(sync.audio, "/media/a1.mp3");
  } finally {
    screen.close();
  }
});

test("without matching video lengths the first audio spans the cycle", async () => {
  const screen = await registerScreen(server.wsBase, "lista", { instance: "s3", duration: 30 });
  try {
    const { sync } = await mobileSync(server.wsBase, "lista", "s3");
    assert.deepEqual(sync.items, [{ audio: "/media/a1.mp3", start: 0, duration: 30 }]);
  } finally {
    screen.close();
  }
});

test("a screen loading new content tells its listening phones to sync again", async () => {
  const screen = await registerScreen(server.wsBase, "lista", { instance: "s4" });
  const phone = await connect(`${server.wsBase}/ws/drift/lista?instance=s4`);
  try {
    screen.send({ current_time: 0, duration: 30, items: [10, 20], mode: "sync", drift_enabled: true });
    await phone.next("content_changed");
  } finally {
    phone.close();
    screen.close();
  }
});

test("outside its period a campaign shows its fallback (with the fallback's links)", async () => {
  const screen = await registerScreen(server.wsBase, "lista", { instance: "s5" });
  try {
    await screen.next("change_video");
    screen.messages.length = 0;
    const r = await call("PATCH", "/api/totem/lista", { schedule: { end: PAST, fallback: "padrao" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const msg = await screen.next("change_video");
    assert.equal(msg.source, "padrao");
    assert.deepEqual(msg.playlist.map(i => i.video), ["d.mp4"]);
    const { sync } = await mobileSync(server.wsBase, "lista", "s5");
    assert.equal(sync.promo.text, "Promo padrão");
    assert.equal((await totem("lista")).showing, "padrao");
  } finally {
    screen.close();
  }
});

test("outside its period without a fallback: idle screen, phones are told to wait", async () => {
  const screen = await registerScreen(server.wsBase, "lista", { instance: "s6" });
  try {
    await screen.next("change_video");
    screen.messages.length = 0;
    await call("PATCH", "/api/totem/lista", { schedule: { start: FUTURE } });
    const msg = await screen.next("change_video");
    assert.equal(msg.idle, true);
    assert.deepEqual(msg.playlist, []);
    const { code } = await mobileSync(server.wsBase, "lista", "s6");
    assert.equal(code, 4010);
    assert.equal((await totem("lista")).showing, null);
  } finally {
    screen.close();
  }
});

test("a period starting soon switches the open screens by itself", async () => {
  const start = new Date(Date.now() + 1500).toISOString();
  await call("PATCH", "/api/totem/lista", { schedule: { start } });
  const screen = await registerScreen(server.wsBase, "lista", { instance: "s7" });
  try {
    assert.equal((await screen.next("change_video")).idle, true);
    screen.messages.length = 0;
    const msg = await screen.next("change_video", 8000);
    assert.equal(msg.idle, false);
    assert.equal(msg.source, "lista");
  } finally {
    screen.close();
    await call("PATCH", "/api/totem/lista", { schedule: null });
  }
});

test("schedule validation", async () => {
  assert.equal((await call("PATCH", "/api/totem/lista", { schedule: { fallback: "lista" } })).status, 400);
  assert.equal((await call("PATCH", "/api/totem/lista", { schedule: { fallback: "nao_existe" } })).status, 400);
  assert.equal((await call("PATCH", "/api/totem/lista", { schedule: { start: FUTURE, end: PAST } })).status, 400);
  assert.equal((await call("PATCH", "/api/totem/lista", { playlist: [{ video: "nao.mp4" }] })).status, 400);
});

test("media in any playlist item: rename follows, delete is refused", async () => {
  await call("POST", "/api/totem/lista/config", { playlist: PLAYLIST });
  const del = await call("DELETE", "/api/media/a2.mp3");
  assert.equal(del.status, 409);
  assert.deepEqual(del.body.used_by, ["lista"]);
  const ren = await call("PATCH", "/api/media/a2.mp3", { filename: "a2_novo.mp3" });
  assert.equal(ren.status, 200);
  assert.equal((await totem("lista")).playlist[1].audio, "a2_novo.mp3");
});

test("renaming or deleting a fallback campaign updates who falls back to it", async () => {
  await call("POST", "/api/totems", { id: "reserva", video: "d.mp4", audio: "d.mp3" });
  await call("PATCH", "/api/totem/lista", { schedule: { end: PAST, fallback: "reserva" } });
  assert.equal((await call("PATCH", "/api/totem/reserva", { id: "reserva2" })).status, 200);
  assert.equal((await totem("lista")).schedule.fallback, "reserva2");
  assert.equal((await totem("lista")).showing, "reserva2");
  assert.equal((await call("DELETE", "/api/totem/reserva2")).status, 200);
  assert.equal((await totem("lista")).schedule.fallback, null);
  assert.equal((await totem("lista")).showing, null);
  await call("PATCH", "/api/totem/lista", { schedule: null });
});

test("creating a campaign with a playlist and a schedule", async () => {
  const r = await call("POST", "/api/totems", {
    id: "nova", playlist: PLAYLIST.slice(0, 1).concat([{ video: "d.mp4", audio: "" }]),
    schedule: { start: PAST, fallback: "padrao" },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const t = await totem("nova");
  assert.deepEqual(t.playlist, [{ video: "v1.mp4", audio: "a1.mp3" }, { video: "d.mp4", audio: "" }]);
  assert.equal(t.video, "v1.mp4");
  assert.equal(t.schedule.fallback, "padrao");
});
