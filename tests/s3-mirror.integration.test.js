const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startServer } = require("./helpers/server");
const { startFakeS3 } = require("./helpers/fake-s3");

const s3Env = endpoint => ({
  S3_BUCKET: "midia",
  S3_PREFIX: "audiosync",
  S3_REGION: "us-east-1",
  S3_ENDPOINT: endpoint,
  AWS_ACCESS_KEY_ID: "test",
  AWS_SECRET_ACCESS_KEY: "test",
});

async function api(server, cookie, method, p, body, type = "application/json") {
  const res = await fetch(server.base + p, {
    method,
    headers: { Cookie: cookie, "Content-Type": type },
    body: body === undefined ? undefined : type === "application/json" ? JSON.stringify(body) : body,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe("admin changes are mirrored to S3", () => {
  let s3, server, assets, cookie;
  before(async () => {
    s3 = await startFakeS3();
    assets = fs.mkdtempSync(path.join(os.tmpdir(), "assets-"));
    server = await startServer({ env: { ...s3Env(s3.endpoint), ASSETS_DIR: assets } });
    cookie = await server.login();
  });
  after(() => {
    server.stop();
    s3.stop();
    fs.rmSync(assets, { recursive: true, force: true });
  });

  test("upload, replace, rename and delete", async () => {
    let r = await api(server, cookie, "POST", "/api/media?filename=Spot%20Um.mp3", Buffer.from("v1"), "application/octet-stream");
    assert.equal(r.status, 201);
    assert.equal(r.body.storage_error, undefined);
    let obj = s3.objects.get("midia/audiosync/Spot_Um.mp3");
    assert.equal(obj.body.toString(), "v1");
    assert.equal(obj.contentType, "audio/mpeg");
    assert.equal(obj.cacheControl, "public, max-age=60");
    assert.ok(fs.existsSync(path.join(assets, "Spot_Um.mp3")), "local copy is kept");

    r = await api(server, cookie, "PUT", "/api/media/Spot_Um.mp3", Buffer.from("v2!"), "application/octet-stream");
    assert.equal(r.status, 200);
    assert.equal(s3.objects.get("midia/audiosync/Spot_Um.mp3").body.toString(), "v2!");

    r = await api(server, cookie, "PATCH", "/api/media/Spot_Um.mp3", { filename: "spot-dois.mp3" });
    assert.equal(r.status, 200);
    assert.equal(s3.objects.has("midia/audiosync/Spot_Um.mp3"), false);
    assert.equal(s3.objects.get("midia/audiosync/spot-dois.mp3").body.toString(), "v2!");

    r = await api(server, cookie, "DELETE", "/api/media/spot-dois.mp3");
    assert.equal(r.status, 200);
    assert.equal(s3.objects.has("midia/audiosync/spot-dois.mp3"), false);
  });

  let hasFfmpeg = true;
  try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); } catch { hasFfmpeg = false; }

  test("split uploads both outputs", { skip: !hasFfmpeg && "ffmpeg not installed" }, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "split-s3-"));
    try {
      const input = path.join(tmp, "in.mp4");
      execFileSync("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=1",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", input,
      ]);
      const r = await api(server, cookie, "POST", "/api/media/split?filename=campanha.mp4", fs.readFileSync(input), "application/octet-stream");
      assert.equal(r.status, 201);
      assert.ok(s3.objects.has("midia/audiosync/campanha_video.mp4"));
      assert.ok(s3.objects.has("midia/audiosync/campanha_audio.mp3"));
      assert.equal(s3.objects.get("midia/audiosync/campanha_video.mp4").contentType, "video/mp4");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("s3-sync uploads only missing or changed files", async () => {
    fs.writeFileSync(path.join(assets, "antigo.mp3"), "old file");
    s3.objects.delete("midia/audiosync/campanha_audio.mp3"); // pretend it was lost remotely
    // Async on purpose: the fake S3 runs in this process and must keep answering
    const { stdout: out } = await execFileAsync(process.execPath, ["scripts/s3-sync.js"], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, ...s3Env(s3.endpoint), ASSETS_DIR: assets },
      timeout: 30000,
    });
    assert.equal(s3.objects.get("midia/audiosync/antigo.mp3").body.toString(), "old file");
    assert.match(out, /antigo\.mp3/);
    if (hasFfmpeg) {
      assert.ok(s3.objects.has("midia/audiosync/campanha_audio.mp3"));
      assert.match(out, /campanha_video\.mp4 .*já está no S3/);
    }
  });
});

describe("S3 failure does not lose the upload", () => {
  let server, assets;
  before(async () => {
    assets = fs.mkdtempSync(path.join(os.tmpdir(), "assets-"));
    // Nothing listens on port 9 → every S3 call fails
    server = await startServer({ env: { ...s3Env("http://127.0.0.1:9"), ASSETS_DIR: assets } });
  });
  after(() => {
    server.stop();
    fs.rmSync(assets, { recursive: true, force: true });
  });

  test("file is saved locally and the error is reported", async () => {
    const cookie = await server.login();
    const r = await api(server, cookie, "POST", "/api/media?filename=x.mp3", Buffer.from("data"), "application/octet-stream");
    assert.equal(r.status, 201);
    assert.match(r.body.storage_error, /S3/);
    assert.ok(fs.existsSync(path.join(assets, "x.mp3")));
  });
});
