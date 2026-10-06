const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startServer } = require("./helpers/server");
const { startFakeS3 } = require("./helpers/fake-s3");
const { registerScreen } = require("./helpers/ws");

const execFileAsync = promisify(execFile);
const CDN = "https://cdn.exemplo.com/audiosync";

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
    redirect: "manual",
    headers: { Cookie: cookie, "Content-Type": type },
    body: body === undefined ? undefined : type === "application/json" ? JSON.stringify(body) : body,
  });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => ({})) };
}
const upload = (server, cookie, name, content) =>
  api(server, cookie, "POST", `/api/media?filename=${encodeURIComponent(name)}`, Buffer.from(content), "application/octet-stream");

let hasFfmpeg = true;
try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); } catch { hasFfmpeg = false; }

describe("S3-only media library", () => {
  let s3, server, assets, cookie;
  before(async () => {
    s3 = await startFakeS3();
    // Already in the bucket before the server starts
    s3.objects.set("midia/audiosync/existente.mp4", { body: Buffer.from("video-antigo"), contentType: "video/mp4" });
    assets = fs.mkdtempSync(path.join(os.tmpdir(), "assets-"));
    server = await startServer({
      totems: { camp: { video: "existente.mp4", audio: "" } },
      env: { ...s3Env(s3.endpoint), ASSETS_DIR: assets, MEDIA_BASE_URL: CDN },
    });
    cookie = await server.login();
  });
  after(() => {
    server.stop();
    s3.stop();
    fs.rmSync(assets, { recursive: true, force: true });
  });

  test("lists what is in the bucket", async () => {
    const r = await api(server, cookie, "GET", "/api/media");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.map(m => [m.filename, m.type, m.size]), [["existente.mp4", "video", 12]]);
  });

  test("upload goes to S3 only, never to the local folder", async () => {
    const r = await upload(server, cookie, "Spot Um.mp3", "v1");
    assert.equal(r.status, 201);
    const obj = s3.objects.get("midia/audiosync/Spot_Um.mp3");
    assert.equal(obj.body.toString(), "v1");
    assert.equal(obj.contentType, "audio/mpeg");
    assert.deepEqual(fs.readdirSync(assets), [], "nothing saved locally");

    const list = await api(server, cookie, "GET", "/api/media");
    assert.ok(list.body.some(m => m.filename === "Spot_Um.mp3" && m.size === 2));
    assert.equal((await upload(server, cookie, "Spot Um.mp3", "v1")).status, 409, "duplicate name");
  });

  test("replace, rename (totems follow) and delete", async () => {
    let r = await api(server, cookie, "PUT", "/api/media/Spot_Um.mp3", Buffer.from("v2!"), "application/octet-stream");
    assert.equal(r.status, 200);
    assert.equal(s3.objects.get("midia/audiosync/Spot_Um.mp3").body.toString(), "v2!");

    r = await api(server, cookie, "POST", "/api/totem/camp/config", { video: "existente.mp4", audio: "Spot_Um.mp3" });
    assert.equal(r.status, 200);
    r = await api(server, cookie, "PATCH", "/api/media/Spot_Um.mp3", { filename: "spot-dois.mp3" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.updated_totems, ["camp"]);
    assert.equal(s3.objects.has("midia/audiosync/Spot_Um.mp3"), false);
    assert.equal(s3.objects.get("midia/audiosync/spot-dois.mp3").body.toString(), "v2!");

    r = await api(server, cookie, "DELETE", "/api/media/spot-dois.mp3");
    assert.equal(r.status, 409, "in use by camp");
    await api(server, cookie, "POST", "/api/totem/camp/config", { video: "existente.mp4", audio: "existente.mp4" });
    r = await api(server, cookie, "DELETE", "/api/media/spot-dois.mp3");
    assert.equal(r.status, 200);
    assert.equal(s3.objects.has("midia/audiosync/spot-dois.mp3"), false);
    assert.equal((await api(server, cookie, "DELETE", "/api/media/spot-dois.mp3")).status, 404);
  });

  test("totem validation uses the bucket", async () => {
    assert.equal((await api(server, cookie, "POST", "/api/totems", { id: "novo", video: "existente.mp4" })).status, 201);
    assert.equal((await api(server, cookie, "POST", "/api/totems", { id: "outro", video: "nao-existe.mp4" })).status, 400);
  });

  test("screens get CDN URLs and /media redirects to the bucket", async () => {
    const s = await registerScreen(server.wsBase, "camp", { instance: "s3-a" });
    try {
      assert.equal((await s.next("change_video")).url, `${CDN}/existente.mp4`);
    } finally {
      s.close();
    }
    const r = await api(server, cookie, "GET", "/media/existente.mp4");
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), `${CDN}/existente.mp4`);
  });

  test("split uploads both outputs and keeps nothing locally", { skip: !hasFfmpeg && "ffmpeg not installed" }, async () => {
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
      assert.equal(s3.objects.get("midia/audiosync/campanha_video.mp4").contentType, "video/mp4");
      assert.equal(s3.objects.get("midia/audiosync/campanha_audio.mp3").contentType, "audio/mpeg");
      assert.deepEqual(fs.readdirSync(assets), []);
      const again = await api(server, cookie, "POST", "/api/media/split?filename=campanha.mp4", fs.readFileSync(input), "application/octet-stream");
      assert.equal(again.status, 409, "outputs already in the bucket");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("s3-sync migrates files from a local folder", async () => {
    const local = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-"));
    try {
      fs.writeFileSync(path.join(local, "antigo.mp3"), "old file");
      fs.writeFileSync(path.join(local, "existente.mp4"), "video-antigo");
      // Async on purpose: the fake S3 runs in this process and must keep answering
      const { stdout } = await execFileAsync(process.execPath, ["scripts/s3-sync.js"], {
        cwd: path.join(__dirname, ".."),
        // ENV_FILE to a missing file: never read the developer's real .env
        env: { ...process.env, ...s3Env(s3.endpoint), ASSETS_DIR: local, ENV_FILE: path.join(local, "no.env") },
        timeout: 30000,
      });
      assert.equal(s3.objects.get("midia/audiosync/antigo.mp3").body.toString(), "old file");
      assert.match(stdout, /existente\.mp4 já está no S3/);
    } finally {
      fs.rmSync(local, { recursive: true, force: true });
    }
  });
});

describe("S3 unreachable", () => {
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

  test("the admin sees the error and uploads fail without saving locally", async () => {
    const cookie = await server.login();
    const list = await api(server, cookie, "GET", "/api/media");
    assert.equal(list.status, 503);
    assert.match(list.body.error, /S3/);

    const r = await upload(server, cookie, "x.mp3", "data");
    assert.equal(r.status, 502);
    assert.match(r.body.error, /S3/);
    assert.deepEqual(fs.readdirSync(assets), []);
  });
});
