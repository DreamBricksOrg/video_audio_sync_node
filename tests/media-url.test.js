const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createMediaUrl, defaultS3BaseUrl } = require("../lib/media-url");

test("without a base URL, files are served from /media", () => {
  const url = createMediaUrl("");
  assert.equal(url("promo_video.mp4"), "/media/promo_video.mp4");
});

test("with a base URL, files point to the CDN", () => {
  const url = createMediaUrl("https://cdn.exemplo.com/audiosync/");
  assert.equal(url("promo_audio.mp3"), "https://cdn.exemplo.com/audiosync/promo_audio.mp3");
});

test("filenames are URL-encoded and empty names give null", () => {
  const url = createMediaUrl("https://cdn.exemplo.com");
  assert.equal(url("a b.mp4"), "https://cdn.exemplo.com/a%20b.mp4");
  assert.equal(url(""), null);
});

test("default S3 URL: AWS virtual-hosted style with prefix", () => {
  assert.equal(
    defaultS3BaseUrl({ bucket: "midia", region: "sa-east-1", prefix: "/audiosync/" }),
    "https://midia.s3.sa-east-1.amazonaws.com/audiosync",
  );
  assert.equal(defaultS3BaseUrl({ bucket: "midia" }), "https://midia.s3.us-east-1.amazonaws.com");
});

test("default S3 URL: custom endpoint uses path style", () => {
  assert.equal(
    defaultS3BaseUrl({ bucket: "midia", prefix: "a", endpoint: "http://127.0.0.1:9000/" }),
    "http://127.0.0.1:9000/midia/a",
  );
});
