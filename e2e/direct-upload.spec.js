// S3 mode: the admin uploads straight to the bucket; without bucket CORS it
// falls back to uploading through the server
const { test, expect } = require("@playwright/test");
const { startServer } = require("../tests/helpers/server");
const { startFakeS3 } = require("../tests/helpers/fake-s3");

const s3Env = endpoint => ({
  S3_BUCKET: "midia", S3_PREFIX: "audiosync", S3_REGION: "us-east-1", S3_ENDPOINT: endpoint,
  AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test",
});

async function setup(cors) {
  const s3 = await startFakeS3({ cors });
  const server = await startServer({ env: s3Env(s3.endpoint) });
  return { s3, server, stop: () => { server.stop(); s3.stop(); } };
}

async function uploadThroughAdmin(page, server, name) {
  await page.goto(`${server.base}/login`);
  await page.locator("#username").fill("test");
  await page.locator("#password").fill("test-pass");
  await page.locator("#loginBtn").click();
  await expect(page).toHaveURL(/\/admin$/);
  await page.locator("#mediaInput").setInputFiles({ name, mimeType: "audio/mpeg", buffer: Buffer.from("audio-bytes") });
}

test("with bucket CORS the file goes straight to S3", async ({ page }) => {
  const env = await setup(true);
  try {
    await uploadThroughAdmin(page, env.server, "spot direto.mp3");
    await expect(page.locator("#audioList")).toContainText("spot_direto.mp3");
    expect(env.s3.objects.get("midia/audiosync/spot_direto.mp3").body.toString()).toBe("audio-bytes");
    expect(env.server.output()).toContain("direct to S3");
  } finally {
    env.stop();
  }
});

test("without bucket CORS the upload still works, through the server", async ({ page }) => {
  const env = await setup(false);
  try {
    await uploadThroughAdmin(page, env.server, "spot.mp3");
    await expect(page.locator("#audioList")).toContainText("spot.mp3");
    expect(env.s3.objects.get("midia/audiosync/spot.mp3").body.toString()).toBe("audio-bytes");
    expect(env.server.output()).not.toContain("direct to S3");
  } finally {
    env.stop();
  }
});
