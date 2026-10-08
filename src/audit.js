/**
 * Activity log: who did what in the admin. One file per month
 * (audit/YYYY-MM.json in the bucket, or an audit/ folder next to totems.json),
 * kept for 12 months, shared by every server.
 *
 * The middleware records every successful admin action automatically, from
 * the route (method + path) — no passwords or request bodies are stored, only
 * the user, the action and the item it touched.
 */
const fs = require("fs");
const path = require("path");
const { TOTEMS_FILE } = require("./settings");
const { createFileConfigStore, createS3ConfigStore, isConfigConflict } = require("../lib/config-store");
const { createSyncedDoc } = require("../lib/synced-doc");
const { dayKey } = require("../lib/stats");
const { log } = require("./log");

const KEEP_MONTHS = 12;
const MAX_PER_MONTH = 5000;

// method + route → what the log shows; target(req, body) = the item it touched
const ACTIONS = [
  ["POST", /^\/api\/media$/, "Enviou arquivo", (req, b) => b.filename],
  ["POST", /^\/api\/media\/upload-complete$/, "Enviou arquivo", (req, b) => b.filename],
  ["POST", /^\/api\/media\/split$/, "Separou vídeo e áudio", (req, b) => [b.video, b.audio].filter(Boolean).join(" + ")],
  ["PUT", /^\/api\/media\/([^/]+)$/, "Substituiu arquivo", (req, b) => b.filename],
  ["PATCH", /^\/api\/media\/([^/]+)$/, "Renomeou arquivo", (req, b, m) => `${decodeURIComponent(m[1])} → ${b.filename}`],
  ["DELETE", /^\/api\/media\/([^/]+)$/, "Excluiu arquivo", (req, b, m) => decodeURIComponent(m[1])],
  ["POST", /^\/api\/totems$/, "Criou campanha", (req, b) => b.id],
  ["PATCH", /^\/api\/totem\/([^/]+)$/, "Editou campanha", (req, b, m) =>
    (b.renamed_from ? `${b.renamed_from} → ${b.id}` : decodeURIComponent(m[1]))],
  ["DELETE", /^\/api\/totem\/([^/]+)$/, "Excluiu campanha", (req, b, m) => decodeURIComponent(m[1])],
  ["POST", /^\/api\/totem\/([^/]+)\/config$/, "Trocou os vídeos da campanha", (req, b, m) => decodeURIComponent(m[1])],
  ["PUT", /^\/api\/totem\/([^/]+)\/promo$/, "Editou os links do celular", (req, b, m) => decodeURIComponent(m[1])],
  ["POST", /^\/api\/users$/, "Criou usuário", req => req.body && req.body.name],
  ["PATCH", /^\/api\/users\/([^/]+)$/, "Editou usuário", (req, b, m) => decodeURIComponent(m[1])],
  ["DELETE", /^\/api\/users\/([^/]+)$/, "Excluiu usuário", (req, b, m) => decodeURIComponent(m[1])],
  ["POST", /^\/api\/sessions\/revoke-others$/, "Desconectou os outros aparelhos", (req, b) => `${b.revoked} sessão(ões)`],
];

function createAudit({ storage, timeZone = "America/Sao_Paulo", now = () => new Date() }) {
  const monthOf = date => dayKey(date, timeZone).slice(0, 7);
  const name = month => `audit/${month}.json`;
  const file = month => path.join(process.env.AUDIT_DIR || path.join(path.dirname(TOTEMS_FILE), "audit"), `${month}.json`);
  if (!storage.enabled) fs.mkdirSync(path.dirname(file("x")), { recursive: true });

  // month → Promise of the loaded synced doc (one per month, even when several
  // records arrive at once; only the current month is kept)
  const docs = new Map();
  function docFor(month) {
    if (!docs.has(month)) {
      const doc = createSyncedDoc({
        store: storage.enabled ? createS3ConfigStore({ storage, name: name(month) }) : createFileConfigStore({ file: file(month) }),
        isConflict: isConfigConflict,
      });
      docs.clear();
      const loading = doc.load().then(() => doc);
      loading.catch(() => docs.delete(month)); // try again next time
      docs.set(month, loading);
      cleanup(month);
    }
    return docs.get(month);
  }

  function shiftMonth(month, delta) {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    return d.toISOString().slice(0, 7);
  }

  async function cleanup(month) {
    for (let i = KEEP_MONTHS; i < KEEP_MONTHS + 3; i++) {
      const old = shiftMonth(month, -i);
      try {
        if (storage.enabled) await storage.remove(name(old));
        else fs.rmSync(file(old), { force: true });
      } catch (_) {}
    }
  }

  // Adds an entry; a failure is logged but never breaks the action itself
  async function record(user, action, target) {
    const time = now();
    const entry = { time: time.toISOString(), user, action, ...(target ? { target: String(target).slice(0, 200) } : {}) };
    try {
      const doc = await docFor(monthOf(time));
      await doc.mutate(all => {
        all.entries = [...(all.entries || []), entry].slice(-MAX_PER_MONTH);
      });
    } catch (err) {
      log.error("Audit", "Could not record:", err);
    }
  }

  // Newest first: this month and the previous one, up to `limit` entries
  async function read(limit = 300) {
    const month = monthOf(now());
    const out = [];
    for (const m of [month, shiftMonth(month, -1)]) {
      let data = null;
      if (storage.enabled) {
        const found = await storage.getText(name(m));
        data = found && found.body ? JSON.parse(found.body) : null;
      } else if (fs.existsSync(file(m))) {
        data = JSON.parse(fs.readFileSync(file(m), "utf8"));
      }
      out.push(...((data && data.entries) || []).slice().reverse());
      if (out.length >= limit) break;
    }
    return out.slice(0, limit);
  }

  // Express middleware for /api (after the login check): records successful
  // changes. The response body gives the final names (sanitized filename, new id).
  function middleware(req, res, next) {
    if (req.method === "GET" || req.method === "HEAD") return next();
    const route = req.originalUrl.split("?")[0];
    const match = ACTIONS.map(([method, re, action, target]) => [method === req.method && route.match(re), action, target])
      .find(([m]) => m);
    if (!match) return next();
    const [m, action, target] = match;
    let body = {};
    const json = res.json.bind(res);
    res.json = data => {
      body = data || {};
      return json(data);
    };
    res.on("finish", () => {
      if (res.statusCode >= 400 || !req.user) return;
      let item;
      try { item = target(req, body, m); } catch (_) {}
      record(req.user.name, action, item);
    });
    next();
  }

  return { record, read, middleware };
}

module.exports = { createAudit };
