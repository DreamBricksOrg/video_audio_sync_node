/**
 * Daily counters per campaign, for the admin's statistics. No personal data:
 * only counts, listening seconds and the host name of the site embedding a screen.
 *
 * One JSON file per day ("2026-10-07"), shaped like
 *   { "<campaign>": { screens, scans, listeners, listen_seconds, listens, sites: { host: n } } }
 *
 * Each server counts in memory and adds its counts to the day's file on flush()
 * (a synced doc: conditional writes, so several servers add up instead of
 * overwriting each other). Files older than `retentionDays` are deleted.
 *
 * Storage is injected: openDay(day) → synced doc, readDay(day) → object or
 * null (never creates the file), removeDay(day).
 */
const DIRECT = "(direto)";
const UNKNOWN = "(desconhecido)";
const OTHERS = "outros";
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const MAX_LISTEN_SECONDS = 6 * 3600; // one phone left playing for hours shouldn't skew the average

// "YYYY-MM-DD" of `date` in `timeZone`
function dayKey(date, timeZone = "America/Sao_Paulo") {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function shiftDay(day, delta) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// Host name of the embedding site; "" = page opened directly
function sanitizeSite(raw) {
  const host = String(raw || "").trim().toLowerCase();
  if (!host) return DIRECT;
  return host.length <= 253 && HOST_RE.test(host) ? host : UNKNOWN;
}

const emptyCounters = () => ({ screens: 0, scans: 0, listeners: 0, listen_seconds: 0, listens: 0, sites: {} });

// Adds `delta` (same shape as a day file) into `target`
function merge(target, delta, maxSites) {
  for (const [campaign, d] of Object.entries(delta)) {
    const t = target[campaign] = { ...emptyCounters(), ...target[campaign] };
    t.sites = { ...t.sites };
    for (const k of ["screens", "scans", "listeners", "listen_seconds", "listens"]) t[k] += d[k] || 0;
    for (const [site, n] of Object.entries(d.sites || {})) {
      const known = site in t.sites || Object.keys(t.sites).filter(s => s !== OTHERS).length < maxSites;
      const key = known ? site : OTHERS;
      t.sites[key] = (t.sites[key] || 0) + n;
    }
  }
  return target;
}

function createStats({
  openDay, readDay, removeDay,
  now = () => new Date(),
  timeZone = "America/Sao_Paulo",
  retentionDays = 90,
  maxSites = 50,
  accept = () => true, // campaigns worth counting (e.g. only configured ones)
}) {
  let pending = new Map(); // day → { campaign → counters }
  const docs = new Map();  // day → loaded synced doc (today and maybe yesterday)
  let cleanedFor = null;

  const today = () => dayKey(now(), timeZone);

  function counters(campaign) {
    if (!accept(campaign)) return null;
    const day = today();
    if (!pending.has(day)) pending.set(day, {});
    const byCampaign = pending.get(day);
    return byCampaign[campaign] || (byCampaign[campaign] = emptyCounters());
  }

  const record = {
    screenOpened(campaign, site) {
      const c = counters(campaign);
      if (!c) return;
      c.screens++;
      const key = sanitizeSite(site);
      c.sites[key] = (c.sites[key] || 0) + 1;
    },
    scan(campaign) { const c = counters(campaign); if (c) c.scans++; },
    listenStart(campaign) { const c = counters(campaign); if (c) c.listeners++; },
    listenEnd(campaign, seconds) {
      const c = counters(campaign);
      if (!c) return;
      c.listen_seconds += Math.round(Math.min(Math.max(Number(seconds) || 0, 0), MAX_LISTEN_SECONDS));
      c.listens++;
    },
  };

  async function docFor(day) {
    if (!docs.has(day)) {
      const doc = openDay(day);
      await doc.load();
      docs.set(day, doc);
      // Only the latest days get written
      for (const d of docs.keys()) if (d < shiftDay(day, -1)) docs.delete(d);
    }
    return docs.get(day);
  }

  async function cleanup() {
    const day = today();
    if (cleanedFor === day) return;
    cleanedFor = day;
    // A couple of weeks back covers servers that were off for a while
    for (let i = retentionDays + 1; i <= retentionDays + 14; i++) {
      try { await removeDay(shiftDay(day, -i)); } catch (_) {}
    }
  }

  let flushing = Promise.resolve();
  function flush() {
    const run = async () => {
      const batch = pending;
      pending = new Map();
      try {
        for (const [day, delta] of [...batch]) {
          const doc = await docFor(day);
          await doc.mutate(all => { merge(all, delta, maxSites); });
          batch.delete(day);
        }
      } catch (err) {
        // Keep what wasn't saved for the next flush
        for (const [day, delta] of batch) {
          pending.set(day, merge(delta, pending.get(day) || {}, Infinity));
        }
        throw err;
      }
      await cleanup();
    };
    const result = flushing.then(run, run);
    flushing = result.catch(() => {});
    return result;
  }

  // The last `days` days (today included), oldest first
  async function read(days) {
    const end = today();
    const list = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = shiftDay(end, -i);
      list.push({ date, campaigns: (await readDay(date)) || {} });
    }
    return list;
  }

  return { ...record, flush, read, today };
}

const CSV_HEADER = ["data", "campanha", "telas_abertas", "escaneamentos", "celulares_ouvindo", "tempo_medio_s", "sites"];

// ";"-separated with a BOM, so Excel in Portuguese opens it right
function toCsv(days, campaign) {
  const cell = v => (/[;"\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const rows = [CSV_HEADER];
  for (const { date, campaigns } of days) {
    for (const [id, c] of Object.entries(campaigns).sort(([a], [b]) => a.localeCompare(b))) {
      if (campaign && id !== campaign) continue;
      const avg = c.listens ? Math.round(c.listen_seconds / c.listens) : 0;
      const sites = Object.entries(c.sites || {}).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} (${n})`).join(", ");
      rows.push([date, id, c.screens, c.scans, c.listeners, avg, sites]);
    }
  }
  return `﻿${rows.map(r => r.map(cell).join(";")).join("\r\n")}\r\n`;
}

module.exports = { createStats, sanitizeSite, dayKey, shiftDay, toCsv, DIRECT, UNKNOWN };
