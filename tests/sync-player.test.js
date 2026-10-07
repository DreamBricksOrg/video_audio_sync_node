const { test } = require("node:test");
const assert = require("node:assert/strict");
const { timelineFrom, cyclePosition, locate } = require("../static/js/sync-player");

test("timeline from a playlist sync", () => {
  const t = timelineFrom({
    duration: 30,
    items: [{ audio: "/media/a1.mp3", start: 0, duration: 10 }, { audio: null, start: 10, duration: 20 }],
  });
  assert.equal(t.total, 30);
  assert.equal(t.items.length, 2);
  assert.equal(t.items[1].audio, null);
});

test("timeline from an older server (single audio)", () => {
  const t = timelineFrom({ duration: 42, audio: "/media/a.mp3" });
  assert.deepEqual(t, { items: [{ audio: "/media/a.mp3", start: 0, duration: 42 }], total: 42 });
});

test("cycle position wraps on the server clock", () => {
  assert.equal(cyclePosition(1000, 990, 30), 10);
  assert.equal(cyclePosition(1000, 960, 30), 10);
  assert.equal(cyclePosition(990, 1000, 30), 20); // start_time slightly in the future
});

test("locate finds the item and the offset inside it", () => {
  const t = timelineFrom({ duration: 30, items: [{ audio: "a", start: 0, duration: 10 }, { audio: "b", start: 10, duration: 20 }] });
  assert.deepEqual(locate(t, 0), { index: 0, offset: 0 });
  assert.deepEqual(locate(t, 9.5), { index: 0, offset: 9.5 });
  assert.deepEqual(locate(t, 10), { index: 1, offset: 0 });
  assert.deepEqual(locate(t, 29), { index: 1, offset: 19 });
  assert.deepEqual(locate(t, 31), { index: 0, offset: 1 }, "wraps to the start");
});
