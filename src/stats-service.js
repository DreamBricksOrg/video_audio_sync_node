/**
 * Statistics: daily counters per campaign (lib/stats.js), saved one file per
 * day, and the admin routes that read them.
 */
const fs = require("fs");
const path = require("path");
const { TOTEMS_FILE } = require("./settings");
const { createFileConfigStore, createS3ConfigStore, isConfigConflict } = require("../lib/config-store");
const { createSyncedDoc } = require("../lib/synced-doc");
const { createStats, toCsv } = require("../lib/stats");
const { log } = require("./log");

function createStatsService({ storage, campaigns }) {
  // ── Statistics: daily counters per campaign (lib/stats.js) ─────────────────
  // One file per day: stats/YYYY-MM-DD.json in the bucket (shared by every
  // server), or in a stats/ folder next to totems.json in local mode.
  const STATS_DIR = process.env.STATS_DIR || path.join(path.dirname(TOTEMS_FILE), "stats");
  const STATS_TIMEZONE = process.env.STATS_TIMEZONE || "America/Sao_Paulo";
  const STATS_FLUSH_MS = parseInt(process.env.STATS_FLUSH_MS, 10) || 60000;
  const STATS_MAX_DAYS = 90;
  const statsName = day => `stats/${day}.json`;
  const statsFile = day => path.join(STATS_DIR, `${day}.json`);

  const stats = createStats({
    timeZone: STATS_TIMEZONE,
    retentionDays: STATS_MAX_DAYS,
    // Only campaigns that exist: junk ?screen= values don't pile up in the files
    accept: campaign => !!campaigns.conf[campaign],
    openDay: day => createSyncedDoc({
      store: storage.enabled
        ? createS3ConfigStore({ storage, name: statsName(day) })
        : createFileConfigStore({ file: statsFile(day) }),
      isConflict: isConfigConflict,
    }),
    async readDay(day) {
      if (storage.enabled) {
        const found = await storage.getText(statsName(day));
        return found && found.body ? JSON.parse(found.body) : null;
      }
      return fs.existsSync(statsFile(day)) ? JSON.parse(fs.readFileSync(statsFile(day), "utf-8")) : null;
    },
    async removeDay(day) {
      if (storage.enabled) await storage.remove(statsName(day));
      else fs.rmSync(statsFile(day), { force: true });
    },
  });
  if (!storage.enabled) fs.mkdirSync(STATS_DIR, { recursive: true });

  async function flushStats() {
    try {
      await stats.flush();
    } catch (e) {
      log.error("Stats", "Save failed (kept for the next try):", e);
    }
  }
  setInterval(flushStats, STATS_FLUSH_MS).unref();

  // Admin routes (after the login check); storageErrorMessage from the media library
  function register(app, { storageErrorMessage }) {
    // GET /api/stats?days=30 → { timezone, days: [{ date, campaigns }] } (oldest first)
    // GET /api/stats.csv?days=30[&campaign=id] → spreadsheet (; separated)
    async function statsDays(req) {
      const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), STATS_MAX_DAYS);
      await flushStats(); // include what this server counted in the last minute
      return stats.read(days);
    }

    app.get("/api/stats", async (req, res) => {
      try {
        res.json({ timezone: STATS_TIMEZONE, days: await statsDays(req) });
      } catch (err) {
        log.error("Stats", "Read failed:", err);
        res.status(502).json({ error: storageErrorMessage(err) });
      }
    });

    app.get("/api/stats.csv", async (req, res) => {
      try {
        const campaign = req.query.campaign ? String(req.query.campaign) : "";
        const days = await statsDays(req);
        const name = `estatisticas-${campaign ? `${campaign.replace(/[^\w-]/g, "_")}-` : ""}${days[0].date}-a-${days[days.length - 1].date}.csv`;
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
        res.send(toCsv(days, campaign));
      } catch (err) {
        log.error("Stats", "CSV failed:", err);
        res.status(502).json({ error: storageErrorMessage(err) });
      }
    });
  }

  return { stats, flushStats, register, STATS_TIMEZONE };
}

module.exports = { createStatsService };
