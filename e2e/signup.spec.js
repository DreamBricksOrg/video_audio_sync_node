// First access of an @dreambricks.com.br e-mail with the invite password:
// the login page leads to "create your user", which logs the person in
const { test, expect } = require("@playwright/test");
const { startServer } = require("../tests/helpers/server");

let server;
test.beforeAll(async () => {
  server = await startServer({ env: { DEFAULT_USER_PASSWORD: "convite123#x" } });
});
test.afterAll(() => server.stop());

async function fillLogin(page, username, password) {
  await page.goto(`${server.base}/login`);
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);
  await page.locator("#loginBtn").click();
}

test("invite password → create user → logged in as Editor; next time, own password", async ({ page }) => {
  await fillLogin(page, "maria.silva@dreambricks.com.br", "convite123#x");
  await expect(page).toHaveURL(/\/signup$/);
  await expect(page.locator("#signupEmail")).toHaveText("maria.silva@dreambricks.com.br");
  expect(page.url()).not.toContain("token");

  await page.locator("#name").fill("Maria Silva");
  await page.locator("#password").fill("somenteletras");
  await page.locator("#password2").fill("somenteletras");
  await page.locator("#signupBtn").click();
  await expect(page.locator("#signupError")).toContainText("letras e números");

  await page.locator("#password").fill("maria2026");
  await page.locator("#password2").fill("maria2027");
  await page.locator("#signupBtn").click();
  await expect(page.locator("#signupError")).toContainText("não são iguais");

  await page.locator("#password2").fill("maria2026");
  await page.locator("#signupBtn").click();
  await expect(page).toHaveURL(/\/admin/);
  await expect(page.locator("#currentUser")).toHaveText("Maria Silva · Editor");

  await page.locator("#logoutBtn").click();
  await expect(page).toHaveURL(/\/login/);
  await fillLogin(page, "Maria.Silva@dreambricks.com.br", "maria2026");
  await expect(page).toHaveURL(/\/admin/);

  await page.locator("#logoutBtn").click();
  await expect(page).toHaveURL(/\/login/);
  await fillLogin(page, "maria.silva@dreambricks.com.br", "convite123#x");
  await expect(page.locator("#loginError")).toContainText("inválidos");
});

test("opening /signup directly goes back to the login", async ({ page }) => {
  await page.goto(`${server.base}/signup`);
  await expect(page).toHaveURL(/\/login$/);
});
