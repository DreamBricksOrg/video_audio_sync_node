// Totem page: QR per instance, showqr, "Ouvir aqui" on phones, responsive layout
const { test, expect } = require("@playwright/test");
const { startServer } = require("../tests/helpers/server");

let server;
test.beforeAll(async () => {
  server = await startServer({
    totems: { camp: { video: "camp_video.mp4", audio: "camp_audio.mp3" } },
    media: ["camp_video.mp4", "camp_audio.mp3"],
  });
});
test.afterAll(() => server.stop());

test("the QR card links to this screen's own instance", async ({ page }) => {
  await page.goto(`${server.base}/static/totem.html?screen=camp&listen=off`);
  const card = page.locator("#qrLink");
  await expect(card).toBeVisible();
  await expect(page.locator("#qrWrapper canvas, #qrWrapper img").first()).toBeAttached();

  const instance = await page.evaluate(() => INSTANCE_ID);
  const href = await card.getAttribute("href");
  expect(href).toContain("/static/mobile.html?screen=camp");
  expect(href).toContain(`instance=${instance}`);
  expect(await card.getAttribute("target")).toBe("_blank");
});

test("two loads of the same link are two different instances", async ({ browser }) => {
  const [p1, p2] = await Promise.all([browser.newPage(), browser.newPage()]);
  try {
    await Promise.all([p1, p2].map(p => p.goto(`${server.base}/static/totem.html?screen=camp&listen=off`)));
    const [a, b] = await Promise.all([p1, p2].map(p => p.evaluate(() => INSTANCE_ID)));
    expect(a).not.toBe(b);
  } finally {
    await Promise.all([p1.close(), p2.close()]);
  }
});

test("showqr=false removes the QR card", async ({ page }) => {
  await page.goto(`${server.base}/static/totem.html?screen=camp&showqr=false&listen=off`);
  await expect(page.locator(".qr-overlay")).toHaveCount(0);
});

test("on a phone, 'Ouvir aqui' replaces the QR", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    await page.goto(`${server.base}/static/totem.html?screen=camp`);
    // The button appears once the server sends the campaign audio (change_video)
    await expect(page.locator("#listenBtn")).toBeVisible();
    await expect(page.locator("#listenBtn")).toHaveText(/Ouvir aqui/);
    await expect(page.locator(".qr-overlay")).toBeHidden();
  } finally {
    await context.close();
  }
});

test("wide frames move the QR card to the bottom-right corner", async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  try {
    await page.goto(`${server.base}/static/totem.html?screen=camp&listen=off`);
    const box = await page.locator("#qrLink").boundingBox();
    expect(box.x + box.width).toBeGreaterThan(1280 * 0.85);
    expect(box.y + box.height).toBeGreaterThan(720 * 0.85);
  } finally {
    await page.close();
  }
});
