// Phone page: syncs with the scanned instance and shows the campaign links
const { test, expect } = require("@playwright/test");
const { startServer } = require("../tests/helpers/server");
const { registerScreen } = require("../tests/helpers/ws");

let server, screenA, screenB;
test.beforeAll(async () => {
  server = await startServer({
    totems: { camp: { video: "camp_video.mp4", audio: "camp_audio.mp3" } },
    media: ["camp_video.mp4", "camp_audio.mp3"],
  });
  screenA = await registerScreen(server.wsBase, "camp", { instance: "tela-a" });
  screenB = await registerScreen(server.wsBase, "camp", { instance: "tela-b" });
});
test.afterAll(() => {
  screenA.close();
  screenB.close();
  server.stop();
});

test("the phone syncs with the instance from its QR and gets the campaign links", async ({ page }) => {
  await page.goto(`${server.base}/static/mobile_debug.html?screen=camp&instance=tela-a`);
  await expect(page.locator("#screenBadge")).toHaveText("CAMP · tela-a");
  await expect.poll(() => page.evaluate(() => syncData && syncData.instance)).toBe("tela-a");
  // Default promo (99food) delivered with the sync
  await expect(page.locator("#promoText")).toHaveText(/99food/);
  await screenA.next("mobile_connected", 3000); // only the scanned screen is told
  expect(screenB.received("mobile_connected")).toBe(false);
});
