// Admin: a campaign with several videos (reorderable) and a period on air
// with a fallback campaign
const { test, expect } = require("@playwright/test");
const { startServer } = require("../tests/helpers/server");

let server;
test.beforeAll(async () => {
  server = await startServer({
    totems: { padrao: { video: "d.mp4", audio: "d.mp3" } },
    media: ["v1.mp4", "v2.mp4", "d.mp4", "a1.mp3", "a2.mp3", "d.mp3"],
  });
});
test.afterAll(() => server.stop());

async function login(page) {
  await page.goto(`${server.base}/login`);
  await page.locator("#username").fill("test");
  await page.locator("#password").fill("test-pass");
  await page.locator("#loginBtn").click();
  await expect(page).toHaveURL(/\/admin$/);
}

const card = (page, id) => page.locator(".totem-card", { has: page.locator(".totem-id", { hasText: new RegExp(`^${id}$`) }) });
const totem = async id => {
  const res = await fetch(`${server.base}/api/totems`, { headers: { Cookie: await server.login() } });
  return (await res.json()).find(t => t.id === id);
};

test("create a campaign with two videos, reorder them, and schedule it", async ({ page }) => {
  await login(page);
  await page.locator("#addTotemBtn").click();
  await page.locator("#totemIdInput").fill("verao");

  const rows = page.locator("#playlistRows .playlist-row");
  await rows.nth(0).locator(".pl-video").selectOption("v1.mp4");
  await rows.nth(0).locator(".pl-audio").selectOption("a1.mp3");
  await page.locator("#addPlaylistRow").click();
  await rows.nth(1).locator(".pl-video").selectOption("v2.mp4");
  await rows.nth(1).locator(".pl-audio").selectOption("a2.mp3");
  // Second video first
  await rows.nth(1).locator('[data-move="-1"]').click();
  await expect(rows.nth(0).locator(".pl-video")).toHaveValue("v2.mp4");

  // Ended yesterday → shows the fallback campaign now
  const yesterday = new Date(Date.now() - 86400000);
  const pad = n => String(n).padStart(2, "0");
  const local = `${yesterday.getFullYear()}-${pad(yesterday.getMonth() + 1)}-${pad(yesterday.getDate())}T10:00`;
  await page.locator("#totemEnd").fill(local);
  await page.locator("#totemFallback").selectOption("padrao");
  await page.locator("#totemSaveBtn").click();

  const c = card(page, "verao");
  await expect(c.locator(".card-playlist li")).toHaveText(["v2.mp4 + a2.mp3", "v1.mp4 + a1.mp3"]);
  await expect(c.locator(".schedule-note")).toContainText("Terminou em");
  await expect(c.locator(".schedule-note")).toContainText("a campanha padrao");

  const saved = await totem("verao");
  expect(saved.playlist).toEqual([{ video: "v2.mp4", audio: "a2.mp3" }, { video: "v1.mp4", audio: "a1.mp3" }]);
  expect(saved.schedule.fallback).toBe("padrao");
  expect(saved.showing).toBe("padrao");

  // Edit: remove one video and the period → back to the simple card
  await c.locator(".list-btn").click();
  await rows.nth(1).locator("[data-remove]").click();
  await page.locator("#totemEnd").fill("");
  await page.locator("#totemFallback").selectOption("");
  await page.locator("#totemSaveBtn").click();
  await expect(c.locator(".video-select")).toHaveValue("v2.mp4");
  await expect(c.locator(".schedule-note")).toHaveCount(0);
  expect((await totem("verao")).schedule).toBe(null);
});

test("a video is required in every row", async ({ page }) => {
  await login(page);
  await page.locator("#addTotemBtn").click();
  await page.locator("#totemIdInput").fill("incompleta");
  await page.locator("#addPlaylistRow").click();
  await page.locator("#totemSaveBtn").click();
  await expect(page.locator("#totemError")).toContainText("Escolha o vídeo de cada item");
});
