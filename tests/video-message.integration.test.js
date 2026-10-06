const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers/server");
const { registerScreen } = require("./helpers/ws");

let server;
before(async () => {
  server = await startServer({ totems: { camp: { video: "camp_video.mp4", audio: "camp_audio.mp3" } } });
});
after(() => server.stop());

test("change_video on registration includes the campaign audio", async () => {
  const s = await registerScreen(server.wsBase, "camp", { instance: "vm-a" });
  try {
    const msg = await s.next("change_video");
    assert.equal(msg.filename, "camp_video.mp4");
    assert.equal(msg.audio, "/media/camp_audio.mp3");
  } finally {
    s.close();
  }
});

test("without MEDIA_BASE_URL the video url is local", async () => {
  const s = await registerScreen(server.wsBase, "camp", { instance: "vm-local" });
  try {
    const msg = await s.next("change_video");
    assert.equal(msg.url, "/media/camp_video.mp4");
  } finally {
    s.close();
  }
});

test("changing only the audio in the admin notifies open screens", async () => {
  const cookie = await server.login();
  const s = await registerScreen(server.wsBase, "camp", { instance: "vm-b" });
  try {
    await s.next("change_video");
    s.messages.length = 0;
    const res = await fetch(`${server.base}/api/totem/camp/config`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ video: "camp_video.mp4", audio: "novo_audio.mp3" }),
    });
    assert.equal(res.status, 200);
    const msg = await s.next("change_video");
    assert.equal(msg.audio, "/media/novo_audio.mp3");
  } finally {
    s.close();
  }
});

const { describe } = require("node:test");
const { mobileSync } = require("./helpers/ws");

describe("with MEDIA_BASE_URL", () => {
  let cdnServer;
  before(async () => {
    cdnServer = await startServer({
      totems: { camp: { video: "camp_video.mp4", audio: "camp_audio.mp3" } },
      env: { MEDIA_BASE_URL: "https://cdn.exemplo.com/audiosync" },
    });
  });
  after(() => cdnServer.stop());

  test("screens and phones get CDN URLs", async () => {
    const s = await registerScreen(cdnServer.wsBase, "camp", { instance: "cdn-a" });
    try {
      const msg = await s.next("change_video");
      assert.equal(msg.url, "https://cdn.exemplo.com/audiosync/camp_video.mp4");
      assert.equal(msg.audio, "https://cdn.exemplo.com/audiosync/camp_audio.mp3");
      const { sync } = await mobileSync(cdnServer.wsBase, "camp", "cdn-a");
      assert.equal(sync.audio, "https://cdn.exemplo.com/audiosync/camp_audio.mp3");
    } finally {
      s.close();
    }
  });
});
