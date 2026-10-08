// Paginated lists and the hamburger menu on small screens
const { test, expect } = require("@playwright/test");
const { startServer } = require("../tests/helpers/server");

let server;
test.beforeAll(async () => {
  const totems = {};
  for (let i = 1; i <= 15; i++) totems[`camp_${String(i).padStart(2, "0")}`] = { video: "v.mp4", audio: "a.mp3" };
  const media = ["v.mp4", "a.mp3"];
  for (let i = 1; i <= 12; i++) media.push(`extra_${String(i).padStart(2, "0")}.mp4`);
  server = await startServer({ totems, media });
});
test.afterAll(() => server.stop());

async function login(page) {
  await page.goto(`${server.base}/login`);
  await page.locator("#username").fill("test");
  await page.locator("#password").fill("test-pass");
  await page.locator("#loginBtn").click();
  await expect(page).toHaveURL(/\/admin$/);
}

test("campaign cards and media lists are paginated; the page survives the live refresh", async ({ page }) => {
  await login(page);
  const cards = page.locator("#totemGrid .totem-card");
  await expect(cards).toHaveCount(12);
  await expect(page.locator("#pager-totems .pager-info")).toHaveText("1–12 de 15");
  await page.locator('#pager-totems [aria-label="Próxima página"]').click();
  await expect(cards).toHaveCount(3);
  await expect(cards.first().locator(".totem-id")).toHaveText("camp_13");
  await page.waitForTimeout(5500); // the cards refresh every 5s
  await expect(page.locator("#pager-totems .pager-info")).toHaveText("13–15 de 15");

  await page.locator('.nav-tab[data-view="midia"]').click();
  await expect(page.locator("#videoList li")).toHaveCount(10);
  await expect(page.locator("#pager-videos .pager-info")).toHaveText("1–10 de 13");
  await expect(page.locator("#pager-audios")).toBeHidden(); // one audio: no pager
  await page.locator('#pager-videos [aria-label="Próxima página"]').click();
  await expect(page.locator("#videoList li")).toHaveCount(3);
});

test("small screens: the tabs live in a hamburger menu", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await login(page);
  await expect(page.locator("#menuToggle")).toBeVisible();
  await expect(page.locator(".nav-tab[data-view=midia]")).toBeHidden();
  await expect(page.locator("#logoutBtn")).toBeHidden();

  await page.locator("#menuToggle").click();
  await expect(page.locator("#menuToggle")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#menuUser")).toHaveText("test · Admin");
  await page.locator(".nav-tab[data-view=midia]").click();
  await expect(page.locator('.view[data-view="midia"]')).toBeVisible();
  await expect(page.locator(".nav-tab[data-view=midia]")).toBeHidden(); // menu closed

  await page.locator("#menuToggle").click();
  await page.keyboard.press("Escape");
  await expect(page.locator("#menuToggle")).toHaveAttribute("aria-expanded", "false");

  await page.locator("#menuToggle").click();
  await page.locator("#menuLogout").click();
  await expect(page).toHaveURL(/\/login/);
});

test("desktop: tabs in the bar, no hamburger", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await login(page);
  await expect(page.locator("#menuToggle")).toBeHidden();
  await expect(page.locator(".nav-tab[data-view=midia]")).toBeVisible();
});
