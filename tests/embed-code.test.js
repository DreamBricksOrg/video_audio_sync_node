const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildEmbedUrl, buildEmbedCode } = require("../static/js/embed-code");

const base = { origin: "https://audio.exemplo.com/", campaign: "camp_1", width: 360, height: 640 };

test("URL has the campaign and only non-default options", () => {
  assert.equal(buildEmbedUrl(base), "https://audio.exemplo.com/static/totem.html?screen=camp_1");
  assert.equal(
    buildEmbedUrl({ ...base, fit: "contain", showQr: false, listen: "off" }),
    "https://audio.exemplo.com/static/totem.html?screen=camp_1&fit=contain&showqr=false&listen=off",
  );
});

test("fixed-size code uses width/height attributes", () => {
  const code = buildEmbedCode(base);
  assert.match(code, /^<iframe src="https:\/\/audio\.exemplo\.com\/static\/totem\.html\?screen=camp_1"/);
  assert.match(code, /width="360" height="640"/);
  assert.match(code, /allow="autoplay; fullscreen"/);
});

test("responsive code keeps the aspect ratio in a wrapper", () => {
  const code = buildEmbedCode({ ...base, responsive: true });
  assert.match(code, /aspect-ratio:360 \/ 640/);
  assert.match(code, /position:absolute;inset:0;width:100%;height:100%/);
});

test("ampersands in the URL are escaped in the HTML", () => {
  const code = buildEmbedCode({ ...base, fit: "contain" });
  assert.match(code, /screen=camp_1&amp;fit=contain/);
});

test("sizes are clamped to sane integers", () => {
  const code = buildEmbedCode({ ...base, width: "abc", height: 99999 });
  assert.match(code, /width="360" height="4000"/);
});
