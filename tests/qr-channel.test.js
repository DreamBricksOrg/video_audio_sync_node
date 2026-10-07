const { test } = require("node:test");
const assert = require("node:assert/strict");
const { channelName, createQrPublisher, createQrSubscriber } = require("../static/js/qr-channel");

const sleep = ms => new Promise(r => setTimeout(r, ms));

test("channel name is per campaign and optional pair", () => {
  assert.equal(channelName("totem1"), "audiosync-qr:totem1");
  assert.equal(channelName("totem1", "a"), "audiosync-qr:totem1:a");
});

test("subscriber that opens after the totem asks and receives the instance", async () => {
  const pub = createQrPublisher({ campaign: "c1", instance: "inst-1", mobileUrl: "https://x/m?instance=inst-1" });
  const states = [];
  const sub = createQrSubscriber({ campaign: "c1", onChange: s => states.push(s) });
  try {
    await sleep(50);
    assert.deepEqual(states.at(-1), { instance: "inst-1", mobileUrl: "https://x/m?instance=inst-1", hidden: false });
  } finally {
    pub.close();
    sub.close();
  }
});

test("subscriber that opens first gets the instance when the totem appears", async () => {
  const states = [];
  const sub = createQrSubscriber({ campaign: "c2", onChange: s => states.push(s) });
  await sleep(20);
  assert.equal(states.length, 0);
  const pub = createQrPublisher({ campaign: "c2", instance: "inst-2", mobileUrl: "u2" });
  try {
    await sleep(50);
    assert.equal(states.at(-1).instance, "inst-2");
  } finally {
    pub.close();
    sub.close();
  }
});

test("a reloaded totem (new instance) updates the QR, hidden state follows, and leaving clears it", async () => {
  const states = [];
  const sub = createQrSubscriber({ campaign: "c3", onChange: s => states.push(s) });
  const first = createQrPublisher({ campaign: "c3", instance: "old", mobileUrl: "u-old" });
  await sleep(40);
  first.setHidden(true);
  await sleep(40);
  assert.deepEqual(states.at(-1), { instance: "old", mobileUrl: "u-old", hidden: true });

  first.close(); // page unload
  await sleep(40);
  assert.equal(states.at(-1), null, "QR shows 'waiting' while the totem is gone");

  const second = createQrPublisher({ campaign: "c3", instance: "new", mobileUrl: "u-new" });
  try {
    await sleep(40);
    assert.deepEqual(states.at(-1), { instance: "new", mobileUrl: "u-new", hidden: false });
  } finally {
    second.close();
    sub.close();
  }
});

test("pairs keep two totems of the same campaign apart", async () => {
  const a = [], b = [];
  const subA = createQrSubscriber({ campaign: "c4", pair: "a", onChange: s => a.push(s) });
  const subB = createQrSubscriber({ campaign: "c4", pair: "b", onChange: s => b.push(s) });
  const pubA = createQrPublisher({ campaign: "c4", pair: "a", instance: "ia", mobileUrl: "ua" });
  const pubB = createQrPublisher({ campaign: "c4", pair: "b", instance: "ib", mobileUrl: "ub" });
  try {
    await sleep(50);
    assert.equal(a.at(-1).instance, "ia");
    assert.equal(b.at(-1).instance, "ib");
  } finally {
    [subA, subB, pubA, pubB].forEach(x => x.close());
  }
});
