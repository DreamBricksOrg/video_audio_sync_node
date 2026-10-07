// Standalone QR iframe (/qr) following the totem iframe on the same page
const { test, expect } = require("@playwright/test");
const { startServer } = require("../tests/helpers/server");
const { mobileSync } = require("../tests/helpers/ws");

let server;
test.beforeAll(async () => {
  server = await startServer({
    totems: { camp: { video: "camp_video.mp4", audio: "camp_audio.mp3" } },
    media: ["camp_video.mp4", "camp_audio.mp3"],
  });
});
test.afterAll(() => server.stop());

const totemInstance = page => {
  const frame = page.frame({ url: /totem\.html/ });
  return frame ? frame.evaluate(() => (typeof INSTANCE_ID === "string" ? INSTANCE_ID : null)).catch(() => null) : null;
};

test("without a totem on the page the QR waits", async ({ page }) => {
  await page.goto(`${server.base}/qr?screen=camp`);
  await expect(page.locator("body")).toHaveAttribute("data-state", "waiting");
  await expect(page.getByText("Aguardando o vídeo")).toBeVisible();
});

test("the QR follows the totem: same instance, new one on reload, 'connected' on scan", async ({ page }) => {
  await page.goto(`${server.base}/static/embed-preview.html?screen=camp`);
  const qr = page.frameLocator("#qr");

  await expect(qr.locator("body")).toHaveAttribute("data-state", "ready");
  const first = await totemInstance(page);
  expect(first).toBeTruthy();
  await expect(qr.locator("#qrLink")).toHaveAttribute("href", new RegExp(`instance=${first}`));

  // The visitor reloads the video → new instance → the QR updates by itself
  await page.evaluate(() => {
    const f = document.getElementById("totem");
    f.src = f.src;
  });
  await expect.poll(() => totemInstance(page)).not.toBe(first);
  const second = await totemInstance(page);
  await expect(qr.locator("#qrLink")).toHaveAttribute("href", new RegExp(`instance=${second}`));

  // A phone scans this instance → the QR iframe shows "Celular conectado"
  const { sync } = await mobileSync(server.wsBase, "camp", second);
  expect(sync.instance).toBe(second);
  await expect(qr.locator("body")).toHaveAttribute("data-state", "connected");
  await expect(qr.getByText("Celular conectado")).toBeVisible();
});

test("pair links each QR to its own totem when a page has two", async ({ page }) => {
  await page.setContent(`
    <iframe id="t1" src="${server.base}/static/totem.html?screen=camp&showqr=false&listen=off&pair=topo"></iframe>
    <iframe id="t2" src="${server.base}/static/totem.html?screen=camp&showqr=false&listen=off&pair=rodape"></iframe>
    <iframe id="q1" src="${server.base}/qr?screen=camp&pair=topo"></iframe>
    <iframe id="q2" src="${server.base}/qr?screen=camp&pair=rodape"></iframe>`);
  const id = async sel => page.frameLocator(sel).locator("body").evaluate(() => INSTANCE_ID);
  await expect(page.frameLocator("#q1").locator("body")).toHaveAttribute("data-state", "ready");
  await expect(page.frameLocator("#q2").locator("body")).toHaveAttribute("data-state", "ready");
  const [i1, i2] = [await id("#t1"), await id("#t2")];
  expect(i1).not.toBe(i2);
  await expect(page.frameLocator("#q1").locator("#qrLink")).toHaveAttribute("href", new RegExp(`instance=${i1}`));
  await expect(page.frameLocator("#q2").locator("#qrLink")).toHaveAttribute("href", new RegExp(`instance=${i2}`));
});
