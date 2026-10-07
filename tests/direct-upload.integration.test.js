// S3 mode: the browser uploads straight to the bucket with a short-lived URL
// for that one file and size; the server only signs it and registers the file.
const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers/server");
const { startFakeS3 } = require("./helpers/fake-s3");

const s3Env = endpoint => ({
  S3_BUCKET: "midia", S3_PREFIX: "audiosync", S3_REGION: "us-east-1", S3_ENDPOINT: endpoint,
  AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test", MAX_UPLOAD_MB: "1",
});

async function api(server, cookie, method, p, body) {
  const res = await fetch(server.base + p, {
    method, headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// What the admin page does: ask for the URL, PUT the bytes, confirm
async function directUpload(server, cookie, request, content) {
  const signed = await api(server, cookie, "POST", "/api/media/upload-url", { ...request, size: content.length });
  if (signed.status !== 200) return { step: "sign", ...signed };
  const put = await fetch(signed.body.url, { method: "PUT", headers: signed.body.headers, body: content });
  if (!put.ok) return { step: "put", status: put.status };
  return { step: "complete", signed: signed.body, ...(await api(server, cookie, "POST", "/api/media/upload-complete", { filename: signed.body.filename })) };
}

describe("direct upload to S3", () => {
  let s3, server, cookie;
  before(async () => {
    s3 = await startFakeS3();
    s3.objects.set("midia/audiosync/existe.mp3", { body: Buffer.from("old") });
    server = await startServer({ env: s3Env(s3.endpoint) });
    cookie = await server.login();
  });
  after(() => { server.stop(); s3.stop(); });

  test("signs a PUT for that file, which then shows up in the library", async () => {
    const r = await directUpload(server, cookie, { filename: "Promoção Verão.mp4" }, Buffer.from("video-bytes"));
    assert.equal(r.status, 201, JSON.stringify(r));
    assert.equal(r.body.filename, "Promocao_Verao.mp4");
    assert.equal(r.body.size, 11);
    assert.ok(r.signed.expires_in <= 900, "short-lived URL");
    assert.equal(r.signed.headers["Content-Type"], "video/mp4");

    const stored = s3.objects.get("midia/audiosync/Promocao_Verao.mp4");
    assert.equal(stored.body.toString(), "video-bytes");
    assert.equal(stored.contentType, "video/mp4");
    assert.match(stored.cacheControl, /max-age/);
    const lib = await api(server, cookie, "GET", "/api/media");
    assert.ok(lib.body.some(m => m.filename === "Promocao_Verao.mp4" && m.size === 11));
  });

  test("the URL is signed, short-lived and bound to the file's type and size", async () => {
    const { body } = await api(server, cookie, "POST", "/api/media/upload-url", { filename: "a.mp3", size: 3 });
    const url = new URL(body.url);
    assert.ok(url.searchParams.get("X-Amz-Signature"));
    assert.match(url.searchParams.get("X-Amz-SignedHeaders"), /content-length/);
    assert.match(url.searchParams.get("X-Amz-SignedHeaders"), /content-type/);
    assert.ok(Number(url.searchParams.get("X-Amz-Expires")) <= 900);
  });

  test("existing names need overwrite; replace keeps the name", async () => {
    const conflict = await api(server, cookie, "POST", "/api/media/upload-url", { filename: "existe.mp3", size: 3 });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.filename, "existe.mp3");

    const over = await directUpload(server, cookie, { filename: "existe.mp3", overwrite: true }, Buffer.from("new"));
    assert.equal(over.status, 201);
    assert.equal(s3.objects.get("midia/audiosync/existe.mp3").body.toString(), "new");

    const rep = await directUpload(server, cookie, { filename: "qualquer.mp3", replace: "existe.mp3" }, Buffer.from("newer"));
    assert.equal(rep.status, 201);
    assert.equal(rep.body.filename, "existe.mp3");
    assert.equal(s3.objects.get("midia/audiosync/existe.mp3").body.toString(), "newer");

    const wrongExt = await api(server, cookie, "POST", "/api/media/upload-url", { filename: "x.mp4", replace: "existe.mp3", size: 3 });
    assert.equal(wrongExt.status, 400);
    const missing = await api(server, cookie, "POST", "/api/media/upload-url", { filename: "x.mp3", replace: "nao-existe.mp3", size: 3 });
    assert.equal(missing.status, 404);
  });

  test("refuses bad names, empty and oversized files", async () => {
    assert.equal((await api(server, cookie, "POST", "/api/media/upload-url", { filename: "virus.exe", size: 3 })).status, 400);
    assert.equal((await api(server, cookie, "POST", "/api/media/upload-url", { filename: "a.mp3", size: 0 })).status, 400);
    assert.equal((await api(server, cookie, "POST", "/api/media/upload-url", { filename: "a.mp3", size: 2 * 1024 * 1024 })).status, 413);
  });

  test("completing an upload that never reached the bucket fails", async () => {
    const r = await api(server, cookie, "POST", "/api/media/upload-complete", { filename: "fantasma.mp3" });
    assert.equal(r.status, 404);
    assert.equal((await api(server, cookie, "POST", "/api/media/upload-complete", { filename: "../x.mp3" })).status, 400);
  });

  test("admin login is required", async () => {
    const res = await fetch(`${server.base}/api/media/upload-url`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: "a.mp3", size: 1 }),
    });
    assert.equal(res.status, 401);
  });
});

describe("local mode", () => {
  let server, cookie;
  before(async () => {
    server = await startServer();
    cookie = await server.login();
  });
  after(() => server.stop());

  test("tells the page to upload through the server", async () => {
    const r = await api(server, cookie, "POST", "/api/media/upload-url", { filename: "a.mp3", size: 3 });
    assert.equal(r.status, 200);
    assert.equal(r.body.direct, false);
  });
});
