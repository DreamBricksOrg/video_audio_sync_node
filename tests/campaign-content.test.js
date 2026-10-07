const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  playlistOf, isOnAir, activeContent, contentKey, campaignsUsing, renameInConfig,
  sanitizePlaylist, sanitizeSchedule, withPlaylist,
} = require("../lib/campaign-content");

const NOW = new Date("2026-10-07T15:00:00Z");

test("playlistOf: the playlist, or the old single video/audio", () => {
  assert.deepEqual(playlistOf({ video: "v.mp4", audio: "a.mp3" }), [{ video: "v.mp4", audio: "a.mp3" }]);
  assert.deepEqual(playlistOf({ video: "v.mp4" }), [{ video: "v.mp4", audio: "" }]);
  assert.deepEqual(playlistOf({}), []);
  assert.deepEqual(playlistOf(undefined), []);
  const conf = { video: "v1.mp4", audio: "a1.mp3", playlist: [{ video: "v1.mp4", audio: "a1.mp3" }, { video: "v2.mp4", audio: "a2.mp3" }] };
  assert.equal(playlistOf(conf).length, 2);
});

test("withPlaylist keeps video/audio = first item (older servers and pages)", () => {
  const conf = withPlaylist({ promo: { text: "x" } }, [{ video: "v2.mp4", audio: "a2.mp3" }, { video: "v3.mp4", audio: "" }]);
  assert.equal(conf.video, "v2.mp4");
  assert.equal(conf.audio, "a2.mp3");
  assert.equal(conf.playlist.length, 2);
  assert.deepEqual(conf.promo, { text: "x" });
  const single = withPlaylist({}, [{ video: "v.mp4", audio: "a.mp3" }]);
  assert.equal(single.playlist, undefined, "one item stays in the old format");
  const empty = withPlaylist({ video: "old.mp4", playlist: [] }, []);
  assert.equal(empty.video, "");
});

test("isOnAir: no schedule = always; start/end are inclusive/exclusive", () => {
  assert.equal(isOnAir(undefined, NOW), true);
  assert.equal(isOnAir({}, NOW), true);
  assert.equal(isOnAir({ start: "2026-10-07T15:00:00.000Z" }, NOW), true);
  assert.equal(isOnAir({ start: "2026-10-08T00:00:00.000Z" }, NOW), false);
  assert.equal(isOnAir({ end: "2026-10-07T15:00:00.000Z" }, NOW), false);
  assert.equal(isOnAir({ start: "2026-10-01T00:00:00.000Z", end: "2026-10-31T00:00:00.000Z" }, NOW), true);
});

test("activeContent: own playlist on air, fallback outside, idle without one", () => {
  const confs = {
    promo: { video: "p.mp4", audio: "p.mp3", schedule: { end: "2026-10-01T00:00:00.000Z", fallback: "padrao" } },
    padrao: { video: "d.mp4", audio: "d.mp3", promo: { text: "padrão" } },
    sem: { video: "s.mp4", schedule: { start: "2026-12-01T00:00:00.000Z" } },
    vazio: {},
  };
  const promo = activeContent(confs, "promo", NOW);
  assert.equal(promo.source, "padrao");
  assert.deepEqual(promo.playlist, [{ video: "d.mp4", audio: "d.mp3" }]);
  assert.equal(activeContent(confs, "padrao", NOW).source, "padrao");
  assert.equal(activeContent(confs, "sem", NOW), null);
  assert.equal(activeContent(confs, "vazio", NOW), null);
  assert.equal(activeContent(confs, "nao_existe", NOW), null);
});

test("activeContent: fallback chains stop at loops", () => {
  const confs = {
    a: { video: "a.mp4", schedule: { end: "2026-01-01T00:00:00.000Z", fallback: "b" } },
    b: { video: "b.mp4", schedule: { end: "2026-01-01T00:00:00.000Z", fallback: "a" } },
  };
  assert.equal(activeContent(confs, "a", NOW), null);
});

test("contentKey changes when what plays changes", () => {
  const a = contentKey({ source: "x", playlist: [{ video: "v.mp4", audio: "a.mp3" }] });
  assert.equal(a, contentKey({ source: "x", playlist: [{ video: "v.mp4", audio: "a.mp3" }] }));
  assert.notEqual(a, contentKey({ source: "x", playlist: [{ video: "v.mp4", audio: "b.mp3" }] }));
  assert.notEqual(a, contentKey(null));
});

test("campaignsUsing and renameInConfig look inside playlists", () => {
  const confs = {
    one: { video: "v1.mp4", audio: "a1.mp3" },
    list: withPlaylist({}, [{ video: "v1.mp4", audio: "a1.mp3" }, { video: "v2.mp4", audio: "a2.mp3" }]),
  };
  assert.deepEqual(campaignsUsing(confs, "v2.mp4"), ["list"]);
  assert.deepEqual(campaignsUsing(confs, "a1.mp3").sort(), ["list", "one"]);
  const changed = renameInConfig(confs, "a2.mp3", "novo.mp3");
  assert.deepEqual(changed, ["list"]);
  assert.equal(confs.list.playlist[1].audio, "novo.mp3");
  renameInConfig(confs, "v1.mp4", "x.mp4");
  assert.equal(confs.list.video, "x.mp4");
  assert.equal(confs.list.playlist[0].video, "x.mp4");
  assert.equal(confs.one.video, "x.mp4");
});

test("sanitizePlaylist validates against the library", () => {
  const lib = { videos: ["v1.mp4", "v2.mp4"], audios: ["a1.mp3"] };
  assert.deepEqual(sanitizePlaylist([{ video: "v1.mp4", audio: "a1.mp3" }, { video: "v2.mp4" }], lib),
    { playlist: [{ video: "v1.mp4", audio: "a1.mp3" }, { video: "v2.mp4", audio: "" }] });
  assert.match(sanitizePlaylist([{ video: "nao.mp4" }], lib).error, /nao\.mp4/);
  assert.match(sanitizePlaylist([{ video: "v1.mp4", audio: "x.mp3" }], lib).error, /x\.mp3/);
  assert.match(sanitizePlaylist([{ audio: "a1.mp3" }], lib).error, /vídeo/);
  assert.match(sanitizePlaylist("x", lib).error, /lista/);
  assert.match(sanitizePlaylist(Array(21).fill({ video: "v1.mp4" }), lib).error, /20/);
  assert.deepEqual(sanitizePlaylist([], lib), { playlist: [] });
});

test("sanitizeSchedule: ISO dates, end after start, fallback must exist and differ", () => {
  const ids = ["camp", "padrao"];
  assert.deepEqual(sanitizeSchedule(null, "camp", ids), { schedule: null });
  assert.deepEqual(sanitizeSchedule({}, "camp", ids), { schedule: null });
  assert.deepEqual(sanitizeSchedule({ start: "2026-10-10T11:00:00.000Z", fallback: "padrao" }, "camp", ids),
    { schedule: { start: "2026-10-10T11:00:00.000Z", end: null, fallback: "padrao" } });
  assert.match(sanitizeSchedule({ start: "ontem" }, "camp", ids).error, /início/);
  assert.match(sanitizeSchedule({ start: "2026-10-10T00:00:00Z", end: "2026-10-09T00:00:00Z" }, "camp", ids).error, /depois/);
  assert.match(sanitizeSchedule({ fallback: "camp" }, "camp", ids).error, /própria/);
  assert.match(sanitizeSchedule({ fallback: "nao" }, "camp", ids).error, /não existe/);
});
