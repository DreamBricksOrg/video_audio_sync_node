const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildEmbedUrl, buildEmbedCode, buildEmbedParts, buildQrUrl } = require("../static/js/embed-code");

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

test("separate QR: totem without its own QR plus a /qr iframe of the same campaign", () => {
  const code = buildEmbedCode({ ...base, qrSeparate: true, qrWidth: 240, qrHeight: 300 });
  const [totem, qr] = code.split("<!-- QR Code -->");
  assert.match(totem, /totem\.html\?screen=camp_1&amp;showqr=false/);
  assert.match(qr, /<iframe src="https:\/\/audio\.exemplo\.com\/qr\?screen=camp_1" width="240" height="300"/);
});

test("pair links one QR to one totem", () => {
  assert.equal(buildQrUrl({ origin: "https://a.com", campaign: "c", pair: "loja-2" }), "https://a.com/qr?screen=c&pair=loja-2");
  const code = buildEmbedCode({ ...base, qrSeparate: true, pair: "loja-2" });
  assert.match(code, /totem\.html\?screen=camp_1&amp;showqr=false&amp;pair=loja-2/);
  assert.match(code, /\/qr\?screen=camp_1&amp;pair=loja-2/);
});

test("parts: video and QR snippets come separately", () => {
  const single = buildEmbedParts(base);
  assert.equal(single.qr, null);
  assert.equal(single.video, buildEmbedCode(base));

  const parts = buildEmbedParts({ ...base, qrSeparate: true, pair: "topo" });
  assert.match(parts.video, /^<iframe src="[^"]*totem\.html\?screen=camp_1&amp;showqr=false&amp;pair=topo"/);
  assert.doesNotMatch(parts.video, /\/qr\?/);
  assert.match(parts.qr, /^<iframe src="https:\/\/audio\.exemplo\.com\/qr\?screen=camp_1&amp;pair=topo"/);
});

test("sizes are clamped to sane integers", () => {
  const code = buildEmbedCode({ ...base, width: "abc", height: 99999 });
  assert.match(code, /width="360" height="4000"/);
});
