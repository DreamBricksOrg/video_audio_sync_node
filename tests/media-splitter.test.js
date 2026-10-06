const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { splitMedia, probe } = require("../lib/media-splitter");

let hasFfmpeg = true;
try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); } catch { hasFfmpeg = false; }

// Big, high-bitrate test clip (2160x3840) with audio
function makeInput(dir) {
  const input = path.join(dir, "big.mp4");
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=2160x3840:rate=30:duration=1",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-c:v", "libx264", "-crf", "8", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", input,
  ]);
  return input;
}

test("web option re-encodes to a smaller H.264 capped at 1920px", { skip: !hasFfmpeg && "ffmpeg not installed" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "split-web-"));
  try {
    const input = makeInput(dir);
    const copy = await splitMedia(input, { outDir: path.join(dir, "copy") });
    const web = await splitMedia(input, { outDir: path.join(dir, "web"), web: true });

    assert.equal(copy.transcoded, false);
    assert.equal(web.transcoded, true);
    assert.equal(web.web, true);

    const info = await probe(web.video);
    assert.equal(info.video.codec, "h264");
    assert.equal(info.video.width, 1080);
    assert.equal(info.video.height, 1920);
    assert.ok(fs.statSync(web.video).size < fs.statSync(copy.video).size, "web version is smaller");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
