// Admin: create an editor, who logs in without the users and activity sections;
// the admin sees what the editor did in the activity log
const { test, expect } = require("@playwright/test");
const { startServer } = require("../tests/helpers/server");

let server;
test.beforeAll(async () => {
  server = await startServer({ media: ["v.mp4", "a.mp3"] });
});
test.afterAll(() => server.stop());

async function loginAt(page, username, password) {
  await page.goto(`${server.base}/login`);
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);
  await page.locator("#loginBtn").click();
  await expect(page).toHaveURL(/\/admin$/);
}

test("admin creates an editor; the editor has no users/activity sections; the log shows the editor's actions", async ({ browser }) => {
  const adminCtx = await browser.newContext();
  const editorCtx = await browser.newContext();
  try {
    const admin = await adminCtx.newPage();
    await loginAt(admin, "test", "test-pass");
    await expect(admin.locator("#currentUser")).toHaveText("test · Admin");
    await expect(admin.locator("#usersSection")).toBeVisible();
    await expect(admin.locator("#usersList tr")).toHaveCount(1);

    await admin.locator("#newUserName").fill("bia");
    await admin.locator("#newUserPassword").fill("senha-da-bia");
    await admin.locator("#newUserRole").selectOption("editor");
    await admin.locator("#userForm button[type=submit]").click();
    await expect(admin.locator('#usersList tr[data-name="bia"] .user-role')).toHaveValue("editor");

    const editor = await editorCtx.newPage();
    await loginAt(editor, "bia", "senha-da-bia");
    await expect(editor.locator("#currentUser")).toHaveText("bia · Editor");
    await expect(editor.locator("#usersSection")).toBeHidden();
    await expect(editor.locator("#auditSection")).toBeHidden();
    await expect(editor.locator("#revokeOthersBtn")).toBeHidden();

    // The editor creates a campaign
    await editor.locator("#addTotemBtn").click();
    await editor.locator("#totemIdInput").fill("da_bia");
    await editor.locator("#totemSaveBtn").click();
    await expect(editor.locator(".totem-card .totem-id", { hasText: "da_bia" })).toBeVisible();

    await admin.locator("#auditRefresh").click();
    const row = admin.locator("#auditList tr", { hasText: "Criou campanha" });
    await expect(row).toContainText("bia");
    await expect(row).toContainText("da_bia");
    await expect(admin.locator("#auditList tr", { hasText: "Criou usuário" })).toContainText("bia");

    // Demote to nothing: delete the editor → her session ends
    admin.on("dialog", d => d.accept());
    await admin.locator('#usersList tr[data-name="bia"] .user-delete').click();
    await expect(admin.locator('#usersList tr[data-name="bia"]')).toHaveCount(0);
    await editor.goto(`${server.base}/admin`);
    await expect(editor).toHaveURL(/\/login/);
  } finally {
    await adminCtx.close();
    await editorCtx.close();
  }
});
