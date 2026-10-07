// Playlists with real media: the totem plays the videos in order and the
// phone plays each video's audio on the same timeline. Plus the idle screen.
const { test, expect } = require("@playwright/test");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startServer } = require("../tests/helpers/server");

// WebM/WAV: playable by Playwright's Chromium (no proprietary codecs)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playlist-e2e-"));
function make(name, args) {
  const out = path.join(dir, name);
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args, out]);
  return out;
}

let server, cookie;
test.beforeAll(async () => {
  const files = {
    "v1.webm": make("v1.webm", ["-f", "lavfi", "-i", "color=c=red:s=160x90:d=2:r=15", "-c:v", "libvpx", "-b:v", "100k"]),
    "v2.webm": make("v2.webm", ["-f", "lavfi", "-i", "color=c=blue:s=160x90:d=3:r=15", "-c:v", "libvpx", "-b:v", "100k"]),
    "a1.wav": make("a1.wav", ["-f", "lavfi", "-i", "sine=frequency=440:duration=2"]),
    "a2.wav": make("a2.wav", ["-f", "lavfi", "-i", "sine=frequency=660:duration=3"]),
  };
  server = await startServer({
    totems: {
      lista: {
        video: "v1.webm", audio: "a1.wav",
        playlist: [{ video: "v1.webm", audio: "a1.wav" }, { video: "v2.webm", audio: "a2.wav" }],
      },
    },
    files,
  });
  const res = await fetch(`${server.base}/api/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "test", password: "test-pass" }),
  });
  cookie = res.headers.get("set-cookie").split(";")[0];
});
test.afterAll(() => {
  server.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the totem plays the videos in order, then loops", async ({ page }) => {
  await page.goto(`${server.base}/static/totem.html?screen=lista`);
  await expect.poll(() => page.evaluate(() => durations.map(d => Math.round(d)))).toEqual([2, 3]);
  const showing = () => page.evaluate(() => [itemIndex, activeVideo().getAttribute("src")]);
  await expect.poll(showing, { timeout: 6000 }).toEqual([1, "/media/v2.webm"]);
  await expect.poll(showing, { timeout: 6000 }).toEqual([0, "/media/v1.webm"]);
  // The standby element is hidden, the active one visible
  await expect(page.locator(".totem-video:not(.standby)")).toHaveCount(1);
});

test("the phone plays each video's audio in step with the totem", async ({ browser }) => {
  const totem = await browser.newPage();
  await totem.goto(`${server.base}/static/totem.html?screen=lista`);
  await expect.poll(() => totem.evaluate(() => durations.length)).toBe(2);
  const instance = await totem.evaluate(() => INSTANCE_ID);

  const ctx = await browser.newContext();
  const [name, value] = cookie.split("=");
  await ctx.addCookies([{ name, value, url: server.base }]);
  const phone = await ctx.newPage();
  try {
    await phone.goto(`${server.base}/static/mobile_debug.html?screen=lista&instance=${instance}`);
    await expect.poll(() => phone.evaluate(() => !!syncData && (syncData.items || []).length)).toBe(2);
    await phone.locator("#tapOverlay").click();
    await expect.poll(() => phone.evaluate(() => player.isPlaying())).toBe(true);
    await expect.poll(() => phone.evaluate(() => player.isWebAudio()), { timeout: 10000 }).toBe(true);

    // Over a full cycle the phone hears both audios, always where it should be
    const seen = new Set();
    for (const end = Date.now() + 6000; Date.now() < end; await phone.waitForTimeout(250)) {
      const s = await phone.evaluate(() => ({ i: player.itemIndex(), pos: player.position(), exp: player.expected() }));
      let diff = Math.abs(s.pos - s.exp);
      diff = Math.min(diff, 5 - diff); // wrap-around at the cycle end
      expect(diff).toBeLessThan(0.3);
      seen.add(s.i);
    }
    expect([...seen].sort()).toEqual([0, 1]);

    // And the totem agrees on the position in the cycle
    const [phonePos, totemPos] = [
      await phone.evaluate(() => player.expected()),
      await totem.evaluate(() => cyclePosition()),
    ];
    let gap = Math.abs(phonePos - totemPos);
    gap = Math.min(gap, 5 - gap);
    expect(gap).toBeLessThan(0.5);
  } finally {
    await ctx.close();
    await totem.close();
  }
});

test("outside the period with no fallback the totem shows the logo, without QR", async ({ page }) => {
  await page.goto(`${server.base}/static/totem.html?screen=lista`);
  await expect(page.locator("#idleScreen")).toBeHidden();
  const res = await fetch(`${server.base}/api/totem/lista`, {
    method: "PATCH", headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ schedule: { start: "2099-01-01T00:00:00.000Z" } }),
  });
  expect(res.status).toBe(200);
  await expect(page.locator("#idleScreen")).toBeVisible();
  await expect(page.locator(".qr-overlay")).toHaveClass(/hidden/);

  await fetch(`${server.base}/api/totem/lista`, {
    method: "PATCH", headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ schedule: null }),
  });
  await expect(page.locator("#idleScreen")).toBeHidden();
  await expect(page.locator(".qr-overlay")).not.toHaveClass(/hidden/);
});
