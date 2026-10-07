// Admin: login, missing-file warning, embed code boxes, media upload
const { test, expect } = require("@playwright/test");
const { startServer } = require("../tests/helpers/server");

let server;
test.beforeAll(async () => {
  server = await startServer({
    totems: {
      ok: { video: "real.mp4", audio: "real.mp3" },
      broken: { video: "gone.mp4", audio: "real.mp3" },
    },
    media: ["real.mp4", "real.mp3"],
  });
});
test.afterAll(() => server.stop());

// Test-only credentials created by tests/helpers/server.js
async function login(page) {
  await page.goto(`${server.base}/admin`);
  await expect(page).toHaveURL(/\/login/);
  await page.locator("#username").fill("test");
  await page.locator("#password").fill("test-pass");
  await page.locator("#loginBtn").click();
  await expect(page).toHaveURL(/\/admin$/);
}

const card = (page, id) => page.locator(".totem-card", { has: page.locator(".totem-id", { hasText: new RegExp(`^${id}$`) }) });

test("wrong password shows an error and stays on login", async ({ page }) => {
  await page.goto(`${server.base}/login`);
  await page.locator("#username").fill("test");
  await page.locator("#password").fill("wrong");
  await page.locator("#loginBtn").click();
  await expect(page.locator("#loginError")).toHaveText(/inválidos/);
  await expect(page).toHaveURL(/\/login/);
});

test("a totem pointing to a missing file shows a warning; a healthy one does not", async ({ page }) => {
  await login(page);
  await expect(card(page, "broken").locator(".card-note-danger")).toContainText("gone.mp4");
  await expect(card(page, "ok").locator(".card-note-danger")).toHaveCount(0);
});

test("embed: separate QR gives the video and the QR in their own boxes", async ({ page }) => {
  await login(page);
  await card(page, "ok").locator(".embed-btn").click();
  await expect(page.locator("#embedQrCodeGroup")).toBeHidden();

  await page.locator("#embedQrSeparate").check();
  await expect(page.locator("#embedQrCodeGroup")).toBeVisible();
  await expect(page.locator("#embedCodeLabel")).toHaveText("Código do vídeo");
  await expect(page.locator("#embedCode")).toHaveValue(/totem\.html\?screen=ok&amp;showqr=false/);
  await expect(page.locator("#embedCode")).not.toHaveValue(/\/qr\?/);
  await expect(page.locator("#embedQrCode")).toHaveValue(/^<iframe src="[^"]*\/qr\?screen=ok"/);
});

test("uploading a file through the admin adds it to the library", async ({ page }) => {
  await login(page);
  await page.locator("#mediaInput").setInputFiles({ name: "novo spot.mp3", mimeType: "audio/mpeg", buffer: Buffer.from("x") });
  await expect(page.locator("#audioList")).toContainText("novo_spot.mp3");
});

test("logout ends the session; 'disconnect others' logs out the other browsers", async ({ browser }) => {
  // Fresh server: other tests' logins would count as "other devices"
  const own = await startServer();
  const loginAt = async page => {
    await page.goto(`${own.base}/login`);
    await page.locator("#username").fill("test");
    await page.locator("#password").fill("test-pass");
    await page.locator("#loginBtn").click();
    await expect(page).toHaveURL(/\/admin$/);
  };
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  try {
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await loginAt(a);
    await expect(a.locator("#revokeOthersBtn")).toBeHidden();
    await loginAt(b);
    await b.reload();
    await expect(b.locator("#revokeOthersBtn")).toContainText("(1)");

    b.on("dialog", d => d.accept());
    await b.locator("#revokeOthersBtn").click();
    await expect(b.locator("#revokeOthersBtn")).toBeHidden();
    await a.goto(`${own.base}/admin`);
    await expect(a).toHaveURL(/\/login/);

    // Logout: the cookie the browser had no longer works, even if copied
    const [cookie] = await ctxB.cookies();
    await b.locator("#logoutBtn").click();
    await expect(b).toHaveURL(/\/login/);
    const r = await fetch(`${own.base}/api/session`, { headers: { Cookie: `${cookie.name}=${cookie.value}` } });
    expect(r.status).toBe(401);
  } finally {
    await ctxA.close();
    await ctxB.close();
    own.stop();
  }
});
