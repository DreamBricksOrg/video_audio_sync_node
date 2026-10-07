const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createStats, sanitizeSite, dayKey, toCsv } = require("../lib/stats");
const { createSyncedDoc } = require("../lib/synced-doc");

// Day files in memory, shared by every "server" (stats instance) given the same map
function memoryDays(files = new Map()) {
  const isConflict = e => e.code === "PreconditionFailed";
  return {
    files,
    openDay(day) {
      let seen = null;
      const store = {
        async load() { const f = files.get(day); seen = f ? f.v : 0; return structuredClone(f ? f.value : {}); },
        async refresh() {
          const f = files.get(day);
          if (!f || f.v === seen) return null;
          seen = f.v;
          return structuredClone(f.value);
        },
        async save(value) {
          const f = files.get(day);
          if ((f ? f.v : 0) !== seen) { const e = new Error("conflict"); e.code = "PreconditionFailed"; throw e; }
          seen = (f ? f.v : 0) + 1;
          files.set(day, { value: structuredClone(value), v: seen });
        },
      };
      return createSyncedDoc({ store, isConflict });
    },
    async readDay(day) { const f = files.get(day); return f ? structuredClone(f.value) : null; },
    async removeDay(day) { files.delete(day); },
  };
}

const at = iso => () => new Date(iso);

test("dayKey uses the configured time zone", () => {
  // 01:30 UTC is still the previous day in São Paulo (UTC-3)
  assert.equal(dayKey(new Date("2026-10-07T01:30:00Z"), "America/Sao_Paulo"), "2026-10-06");
  assert.equal(dayKey(new Date("2026-10-07T03:30:00Z"), "America/Sao_Paulo"), "2026-10-07");
});

test("counts per campaign per day and averages listening time", async () => {
  const days = memoryDays();
  const stats = createStats({ ...days, now: at("2026-10-07T15:00:00Z"), timeZone: "America/Sao_Paulo" });
  stats.screenOpened("camp", "loja.com.br");
  stats.screenOpened("camp", "loja.com.br");
  stats.screenOpened("camp", "");
  stats.scan("camp");
  stats.listenStart("camp");
  stats.listenStart("camp");
  stats.listenEnd("camp", 30.4);
  stats.listenEnd("camp", 10);
  stats.scan("outra");
  await stats.flush();

  const [day] = await stats.read(1);
  assert.equal(day.date, "2026-10-07");
  assert.deepEqual(day.campaigns.camp, {
    screens: 3, scans: 1, listeners: 2, listen_seconds: 40, listens: 2,
    sites: { "loja.com.br": 2, "(direto)": 1 },
  });
  assert.equal(day.campaigns.outra.scans, 1);
});

test("two servers add up instead of overwriting each other", async () => {
  const shared = new Map();
  const a = createStats({ ...memoryDays(shared), now: at("2026-10-07T15:00:00Z") });
  const b = createStats({ ...memoryDays(shared), now: at("2026-10-07T15:00:00Z") });
  a.scan("camp");
  b.scan("camp");
  b.scan("camp");
  await Promise.all([a.flush(), b.flush()]);
  a.scan("camp");
  await a.flush();
  const [day] = await a.read(1);
  assert.equal(day.campaigns.camp.scans, 4);
});

test("a failed flush keeps the counts for the next one", async () => {
  const days = memoryDays();
  let fail = true;
  const openDay = day => {
    const doc = days.openDay(day);
    return { ...doc, mutate: fn => (fail ? Promise.reject(new Error("S3 down")) : doc.mutate(fn)) };
  };
  const stats = createStats({ ...days, openDay, now: at("2026-10-07T15:00:00Z") });
  stats.scan("camp");
  await assert.rejects(stats.flush(), /S3 down/);
  fail = false;
  stats.scan("camp");
  await stats.flush();
  assert.equal((await stats.read(1))[0].campaigns.camp.scans, 2);
});

test("read returns every day of the period, oldest first, empty days included", async () => {
  const days = memoryDays();
  let now = new Date("2026-10-05T15:00:00Z");
  const stats = createStats({ ...days, now: () => now });
  stats.scan("camp");
  await stats.flush();
  now = new Date("2026-10-07T15:00:00Z");
  const list = await stats.read(3);
  assert.deepEqual(list.map(d => d.date), ["2026-10-05", "2026-10-06", "2026-10-07"]);
  assert.equal(list[0].campaigns.camp.scans, 1);
  assert.deepEqual(list[1].campaigns, {});
});

test("days older than the retention are deleted", async () => {
  const days = memoryDays();
  days.files.set("2026-07-08", { value: {}, v: 1 }); // 91 days before 2026-10-07
  days.files.set("2026-07-09", { value: {}, v: 1 }); // 90 days before: kept
  const stats = createStats({ ...days, now: at("2026-10-07T15:00:00Z"), retentionDays: 90 });
  stats.scan("camp");
  await stats.flush();
  assert.ok(!days.files.has("2026-07-08"));
  assert.ok(days.files.has("2026-07-09"));
});

test("sites: only a host name, junk becomes unknown, too many become 'outros'", () => {
  assert.equal(sanitizeSite("Loja.COM.br"), "loja.com.br");
  assert.equal(sanitizeSite(""), "(direto)");
  assert.equal(sanitizeSite("<script>"), "(desconhecido)");
  assert.equal(sanitizeSite("a".repeat(300)), "(desconhecido)");
});

test("at most N distinct sites per campaign per day", async () => {
  const days = memoryDays();
  const stats = createStats({ ...days, now: at("2026-10-07T15:00:00Z"), maxSites: 2 });
  ["a.com", "b.com", "c.com", "d.com"].forEach(s => stats.screenOpened("camp", s));
  await stats.flush();
  assert.deepEqual((await stats.read(1))[0].campaigns.camp.sites, { "a.com": 1, "b.com": 1, outros: 2 });
});

test("CSV: one row per day and campaign, ; separated, with sites", () => {
  const csv = toCsv([
    { date: "2026-10-06", campaigns: {} },
    { date: "2026-10-07", campaigns: { camp: { screens: 3, scans: 1, listeners: 2, listen_seconds: 41, listens: 2, sites: { "a.com": 3 } } } },
  ]);
  const lines = csv.replace(/^﻿/, "").trim().split("\r\n");
  assert.equal(lines[0], "data;campanha;telas_abertas;escaneamentos;celulares_ouvindo;tempo_medio_s;sites");
  assert.equal(lines[1], "2026-10-07;camp;3;1;2;21;a.com (3)");
  assert.equal(lines.length, 2);
});

test("campaigns rejected by accept() are not counted", async () => {
  const days = memoryDays();
  const stats = createStats({ ...days, now: at("2026-10-07T15:00:00Z"), accept: c => c === "camp" });
  stats.scan("camp");
  stats.scan("lixo");
  stats.screenOpened("lixo", "a.com");
  stats.listenStart("lixo");
  stats.listenEnd("lixo", 5);
  await stats.flush();
  assert.deepEqual(Object.keys((await stats.read(1))[0].campaigns), ["camp"]);
});
