// Central de Campanhas: search (name, video, audio — accents ignored) and
// filters, together with the pager
const { test, expect } = require("@playwright/test");
const { startServer } = require("../tests/helpers/server");
const { registerScreen } = require("../tests/helpers/ws");

let server, screen;
test.beforeAll(async () => {
  const totems = {};
  for (let i = 1; i <= 14; i++) totems[`loja_${String(i).padStart(2, "0")}`] = { video: "padrao.mp4", audio: "padrao.mp3" };
  totems.promocao_verao = {
    video: "verao1.mp4", audio: "verao1.mp3",
    playlist: [{ video: "verao1.mp4", audio: "verao1.mp3" }, { video: "verao2.mp4", audio: "verao2.mp3" }],
  };
  totems.natal = { video: "natal.mp4", audio: "natal.mp3", schedule: { start: "2099-12-01T03:00:00.000Z" } };
  totems.quebrada = { video: "sumiu.mp4", audio: "padrao.mp3" };
  server = await startServer({
    totems,
    media: ["padrao.mp4", "padrao.mp3", "verao1.mp4", "verao1.mp3", "verao2.mp4", "verao2.mp3", "natal.mp4", "natal.mp3"],
  });
  screen = await registerScreen(server.wsBase, "loja_03", { instance: "aberta" });
});
test.afterAll(() => {
  screen.close();
  server.stop();
});

async function login(page) {
  await page.goto(`${server.base}/login`);
  await page.locator("#username").fill("test");
  await page.locator("#password").fill("test-pass");
  await page.locator("#loginBtn").click();
  await expect(page).toHaveURL(/\/admin$/);
}

test("the page is called Central de Campanhas", async ({ page }) => {
  await login(page);
  await expect(page.locator('.view[data-view="campanhas"] h1')).toHaveText("Central de Campanhas");
  await expect(page.locator("#addTotemBtn")).toContainText("Adicionar campanha");
  await expect(page.locator("#campaignCount")).toHaveText("17 campanhas");
});

test("search by name or by a file, ignoring accents; the pager follows", async ({ page }) => {
  await login(page);
  const cards = page.locator("#totemGrid .totem-card");
  const ids = page.locator("#totemGrid .totem-id");
  await page.locator('#pager-totems [aria-label="Próxima página"]').click();
  await expect(page.locator("#pager-totems .pager-info")).toHaveText("13–17 de 17");

  await page.locator("#campaignSearch").fill("PROMOÇÃO");
  await expect(ids).toHaveText(["promocao_verao"]);
  await expect(page.locator("#pager-totems")).toBeHidden(); // back to page 1, one page only
  await expect(page.locator("#campaignCount")).toHaveText("1 de 17 campanhas");

  await page.locator("#campaignSearch").fill("verao2"); // second video of the playlist
  await expect(ids).toHaveText(["promocao_verao"]);

  await page.locator("#campaignSearch").fill("loja");
  await expect(cards).toHaveCount(12);
  await expect(page.locator("#pager-totems .pager-info")).toHaveText("1–12 de 14");

  await page.locator("#campaignSearch").fill("nada assim");
  await expect(page.locator("#totemGrid .empty-state")).toContainText("Nenhuma campanha encontrada");
  await page.locator("#clearCampaignFilters").click();
  await expect(page.locator("#campaignSearch")).toHaveValue("");
  await expect(cards).toHaveCount(12);
});

test("filters: live, several videos, period, missing files; combined with search", async ({ page }) => {
  await login(page);
  const ids = page.locator("#totemGrid .totem-id");
  const filter = value => page.locator("#campaignFilter").selectOption(value);

  await filter("online");
  await expect(ids).toHaveText(["loja_03"]);
  await filter("playlist");
  await expect(ids).toHaveText(["promocao_verao"]);
  await filter("scheduled");
  await expect(ids).toHaveText(["natal"]);
  await filter("off-air");
  await expect(ids).toHaveText(["natal"]);
  await filter("problem");
  await expect(ids).toHaveText(["quebrada"]);

  await filter("offline");
  await page.locator("#campaignSearch").fill("loja_0");
  await expect(ids).toHaveCount(8); // loja_01..09 minus loja_03 (online)
  await expect(page.locator("#campaignCount")).toHaveText("8 de 17 campanhas");
});
