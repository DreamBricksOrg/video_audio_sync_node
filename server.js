/**
 * OOH Audio Sync — Node.js Backend (Hardened)
 *
 * Express + ws. Video streamed with Range requests.
 * Sessions stored in-memory (single process).
 *
 * Hardening:
 *   - Max connections per screen (prevents WS flood)
 *   - Graceful error handling on all WS (prevents crash)
 *   - Drift intervals properly cleaned on all exit paths
 *   - try/catch on every ws.send (client may disconnect mid-send)
 *
 * Endpoints:
 *   GET  /health                → Health check
 *   GET  /media/:filename       → Video/audio streaming with Range
 *   WS   /ws/screen/:screenId   → Totem registration
 *   WS   /ws/mobile/:screenId   → Mobile sync
 *   WS   /ws/drift/:screenId    → Drift correction
 *   GET  /static/*              → Static HTML files
 */

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const url = require("url");
const bodyParser = require("body-parser");
const swaggerUi = require("swagger-ui-express");
const YAML = require("yaml");
const { splitMedia, INPUT_EXTS: SPLIT_INPUT_EXTS } = require("./lib/media-splitter");
const { createInstanceRegistry } = require("./lib/instances");
const { createMediaUrl, defaultS3BaseUrl } = require("./lib/media-url");
const { createS3Storage } = require("./lib/s3-storage");
const { createLocalStore, createS3Store } = require("./lib/media-store");
const { createFileConfigStore, createS3ConfigStore, isConfigConflict } = require("./lib/config-store");
const { createSyncedDoc, SyncConflictError } = require("./lib/synced-doc");
const { createStats, toCsv } = require("./lib/stats");
const {
  playlistOf, withPlaylist, activeContent, contentKey, campaignsUsing, renameInConfig,
  sanitizePlaylist, sanitizeSchedule,
} = require("./lib/campaign-content");

// ── Config ──────────────────────────────────────────────────────────────────
// Load .env (Node >= 20.12 built-in); real env vars take precedence.
// ENV_FILE points elsewhere (tests use an empty file so they never touch the real config).
try {
  process.loadEnvFile(process.env.ENV_FILE || path.join(__dirname, ".env"));
} catch (_) {}

const PORT = process.env.PORT || 8001;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
// S3 bucket for the media library (S3_BUCKET set = S3-only, no local copies)
const S3_CONFIG = {
  bucket: process.env.S3_BUCKET,
  region: process.env.S3_REGION,
  prefix: process.env.S3_PREFIX,
  endpoint: process.env.S3_ENDPOINT,
};
// Where visitors download videos/audios: MEDIA_BASE_URL (bucket or CloudFront),
// the bucket URL by default in S3 mode, or this server's /media route
const MEDIA_BASE_URL = process.env.MEDIA_BASE_URL || (S3_CONFIG.bucket ? defaultS3BaseUrl(S3_CONFIG) : "");
const mediaUrl = createMediaUrl(MEDIA_BASE_URL);
const DRIFT_THRESHOLD_MS = 80;
const DRIFT_INTERVAL_MS = 2000;
const MAX_MOBILE_PER_SCREEN = 50;
// Abuse protection for public embeds
const MAX_SCREENS_PER_IP = parseInt(process.env.MAX_SCREENS_PER_IP, 10) || 20;
const MAX_INSTANCES_PER_CAMPAIGN = parseInt(process.env.MAX_INSTANCES_PER_CAMPAIGN, 10) || 2000;
// Phones: many share one IP (venue Wi-Fi, carrier NAT), so these are generous
const MAX_PHONES_PER_IP = parseInt(process.env.MAX_PHONES_PER_IP, 10) || 50;                    // listening at once
const MAX_SYNCS_PER_IP_PER_MINUTE = parseInt(process.env.MAX_SYNCS_PER_IP_PER_MINUTE, 10) || 120;
// Behind a proxy/tunnel (ngrok, Nginx, Cloudflare) set TRUST_PROXY=1 to use X-Forwarded-For
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const ASSETS_DIR = process.env.ASSETS_DIR || path.join(__dirname, "assets");
const STATIC_DIR = path.join(__dirname, "static");

const MAX_UPLOAD_BYTES = (parseInt(process.env.MAX_UPLOAD_MB, 10) || 500) * 1024 * 1024;
const VIDEO_EXTS = [".mp4", ".webm"];
const AUDIO_EXTS = [".mp3", ".wav", ".ogg"];
const MEDIA_EXTS = [...VIDEO_EXTS, ...AUDIO_EXTS];

// Admin auth — credentials come from .env
const ADMIN_USER = process.env.ADMIN_USER || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
// Without a fixed secret, logins are invalidated on every restart
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const SESSION_COOKIE = "db_admin";
const LOGIN_MAX_FAILURES = 5;
const LOGIN_LOCK_MS = 60 * 1000;

const MIME_TYPES = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
};

// Media library: the S3 bucket when S3_BUCKET is set (S3-only), otherwise assets/
const storage = createS3Storage({
  ...S3_CONFIG,
  contentTypeFor: f => MIME_TYPES[path.extname(f).toLowerCase()] || "application/octet-stream",
});
const mediaStore = storage.enabled
  ? createS3Store({ storage, exts: MEDIA_EXTS })
  : createLocalStore({ dir: ASSETS_DIR, exts: MEDIA_EXTS });

// ── In-memory stores & Config ───────────────────────────────────────────────
// TOTEMS_FILE lets tests (and deployments) keep the config elsewhere
const TOTEMS_FILE = process.env.TOTEMS_FILE || path.join(__dirname, "totems.json");
// Every screen playing a campaign (totem or iframe) is an instance with its own session
const instances = createInstanceRegistry();
// Forget screens that closed more than 2 minutes ago (and have no phones listening)
setInterval(() => instances.sweep(), 30000).unref();

// Sends a message to every open screen of a campaign; returns how many got it
function sendToCampaign(campaign, message) {
  const online = instances.online(campaign);
  online.forEach(inst => safeSend(inst.ws, message));
  return online.length;
}

// What a campaign shows right now: its playlist, its fallback campaign's
// (outside its schedule), or null = nothing (black screen with logo)
const contentFor = campaign => activeContent(totemsConf, campaign, new Date());

// What a screen needs to play a campaign: the videos in order, each with the
// audio for "Ouvir aqui". filename/url/audio = first item (older pages).
function videoMessage(campaign) {
  const content = contentFor(campaign);
  const playlist = content ? content.playlist : [];
  const first = playlist[0] || {};
  return {
    type: "change_video",
    filename: first.video || "",
    url: mediaUrl(first.video),
    audio: mediaUrl(first.audio),
    playlist: playlist.map(i => ({ video: i.video, url: mediaUrl(i.video), audio: mediaUrl(i.audio) })),
    idle: !content,
    source: content ? content.source : null,
    key: contentKey(content),
  };
}

// Sends the content to the open screens of every campaign whose content
// changed since it was last sent (config edits, other servers, schedule start/
// end), and tells their listening phones to sync again.
const sentContentKeys = new Map(); // campaign → key last sent to its screens
function broadcastContent() {
  const online = new Set(instances.campaignsOnline());
  for (const id of sentContentKeys.keys()) if (!online.has(id)) sentContentKeys.delete(id);
  for (const id of online) {
    const msg = videoMessage(id);
    if (sentContentKeys.get(id) === msg.key) continue;
    sentContentKeys.set(id, msg.key);
    for (const inst of instances.online(id)) {
      safeSend(inst.ws, msg);
      notifyPhones(inst);
    }
  }
}

// Phones listening to an instance: what they play changed, sync again
function notifyPhones(inst) {
  inst.drifts.forEach(ws => safeSend(ws, { type: "content_changed" }));
}

// ── Safe WS send ────────────────────────────────────────────────────────────
function safeSend(ws, data) {
  try {
    if (ws.readyState === 1) {
      ws.send(typeof data === "string" ? data : JSON.stringify(data));
    }
  } catch (_) {
    // Client gone — ignore
  }
}

// ── Express app ─────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

// CORS — off by default. Pages, iframes and phones all talk to this same
// origin, so nothing needs it. CORS_ORIGINS (comma-separated, or "*") opens
// only the read-only public routes; the admin API is never exposed.
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
const CORS_PUBLIC_PATHS = [/^\/media\//, /^\/health$/];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const isPublic = CORS_PUBLIC_PATHS.some(re => re.test(req.path));
  if (!origin || !isPublic || !CORS_ORIGINS.length) return next();

  res.vary("Origin");
  if (!CORS_ORIGINS.includes("*") && !CORS_ORIGINS.includes(origin)) return next();

  res.header("Access-Control-Allow-Origin", origin);
  res.header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Range");
  res.header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, ETag");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// JSON parsing
app.use(bodyParser.json());

// ── Campaigns config (totems.json) ──────────────────────────────────────────
// Local file, or <prefix>/totems.json in the bucket in S3 mode — shared by every
// server using that bucket/prefix, so they can't drift apart. Loaded at startup.
const CONFIG_REFRESH_MS = parseInt(process.env.CONFIG_REFRESH_MS, 10) || 15000;

// The local file seeds the bucket the first time S3 mode starts
function readLocalTotems() {
  try {
    return fs.existsSync(TOTEMS_FILE) ? JSON.parse(fs.readFileSync(TOTEMS_FILE, "utf-8") || "{}") : {};
  } catch (e) {
    console.error("Failed to parse totems.json", e.message);
    return {};
  }
}

const configStore = storage.enabled
  ? createS3ConfigStore({ storage, seed: readLocalTotems })
  : createFileConfigStore({ file: TOTEMS_FILE });

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
  accept: campaign => !!totemsConf[campaign],
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
    console.error("[Stats] Save failed (kept for the next try):", e.message);
  }
}
setInterval(flushStats, STATS_FLUSH_MS).unref();

// Map from totem Id => configuration { video, audio, promo }
let totemsConf = {};

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// Config changed elsewhere (another server): adopt it and switch this server's
// open screens whose content changed
function applyRemoteConfig(next) {
  totemsConf = next;
  broadcastContent();
}

const configDoc = createSyncedDoc({
  store: configStore,
  isConflict: isConfigConflict,
  onChange: (prev, next) => {
    applyRemoteConfig(next);
    console.log("[Config] Reloaded (changed by another server)");
  },
});

async function refreshConfig() {
  try {
    await configDoc.refresh();
  } catch (e) {
    console.error("[Config] Refresh failed:", e.message);
  }
}

// The only way to change the config: re-read the latest version, apply
// mutate(conf) to a copy, save it conditionally, and retry if another server
// saved in between. mutate may throw HttpError; its return value is passed on.
async function mutateConfig(mutate) {
  try {
    return await configDoc.mutate(mutate);
  } catch (err) {
    if (err instanceof SyncConflictError) {
      throw new HttpError(409, "A configuração foi alterada ao mesmo tempo em outro servidor. Tente de novo.");
    }
    throw err;
  } finally {
    totemsConf = configDoc.get();
    broadcastContent(); // open screens follow the new config right away
  }
}

// Schedules start and end on their own: check every few seconds
setInterval(broadcastContent, 5000).unref();

// HttpError → its status; anything else = the config storage failed
function sendError(res, err, context) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
  console.error(`[${context}]`, err.message);
  res.status(502).json({
    error: configStore.remote
      ? `Não foi possível salvar a configuração no S3: ${err.message}`
      : "Não foi possível salvar a configuração",
  });
}

// ── Mobile page promo (text + links), per totem ────────────────────────────
// Used for totems that never had their links edited in the admin.
const DEFAULT_PROMO = {
  text: "Enquanto escuta a propaganda, aproveite para saber mais sobre a 99food",
  app: {
    label: "Baixar App",
    ios: "https://apps.apple.com/br/app/99-corridas-food-pay/id553663691",
    android: "https://play.google.com/store/apps/details?id=com.taxis99",
    fallback: "https://99app.com/99food/",
  },
  links: [
    { label: "Site", url: "https://99app.com/99food/", icon: "utensils" },
    { label: "Inst", url: "https://instagram.com/99brasil", icon: "camera" },
    { label: "X", url: "https://x.com/voude99", icon: "at-sign" },
  ],
};

// Lucide icon names the admin can pick for a link button
const PROMO_ICONS = [
  "link", "globe", "utensils", "shopping-bag", "camera", "at-sign", "message-circle",
  "play", "music", "ticket", "gift", "map-pin", "phone", "mail", "star", "heart",
];
const PROMO_MAX_LINKS = 6;

function promoFor(id) {
  return (totemsConf[id] && totemsConf[id].promo) || DEFAULT_PROMO;
}

// Validates admin input; returns { promo } or { error }. Only http(s) URLs are
// accepted, since they end up as links on the public mobile page.
function sanitizePromo(input) {
  if (!input || typeof input !== "object") return { error: "Dados inválidos" };

  const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const url = (v, field) => {
    const s = str(v, 2000);
    if (!s) return "";
    try {
      const u = new URL(s);
      if (u.protocol === "http:" || u.protocol === "https:") return u.href;
    } catch (_) {}
    throw new Error(`${field}: digite o endereço completo, começando com https://`);
  };

  try {
    const app = input.app || {};
    const promo = {
      text: str(input.text, 300),
      app: {
        label: str(app.label, 30) || "Baixar App",
        ios: url(app.ios, "App Store (iPhone)"),
        android: url(app.android, "Google Play (Android)"),
        fallback: url(app.fallback, "Outros aparelhos"),
      },
      links: [],
    };

    const links = Array.isArray(input.links) ? input.links : [];
    if (links.length > PROMO_MAX_LINKS) throw new Error(`No máximo ${PROMO_MAX_LINKS} links`);
    links.forEach((l, i) => {
      const label = str(l && l.label, 30);
      const href = url(l && l.url, `Link ${i + 1}`);
      if (!label || !href) throw new Error(`Link ${i + 1}: texto e endereço são obrigatórios`);
      const icon = PROMO_ICONS.includes(l.icon) ? l.icon : "link";
      promo.links.push({ label, url: href, icon });
    });

    return { promo };
  } catch (e) {
    return { error: e.message };
  }
}

// ── Admin auth ──────────────────────────────────────────────────────────────
// The cookie holds a random session id. Sessions live in sessions.json (next to
// totems.json, or in the bucket next to the config in S3 mode, so every server
// shares them), keyed by a hash of the id: reading the file doesn't give
// anyone a usable cookie. Logout deletes the session, so a copied cookie stops
// working. Each session records a tag of the credentials, so changing
// ADMIN_PASSWORD (or SESSION_SECRET) still logs everyone out.
const SESSIONS_NAME = "sessions.json";
const MAX_SESSIONS = 100;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{43}$/;

const sessionStore = storage.enabled
  ? createS3ConfigStore({ storage, name: SESSIONS_NAME })
  : createFileConfigStore({ file: process.env.SESSIONS_FILE || path.join(path.dirname(TOTEMS_FILE), SESSIONS_NAME) });
const sessionsDoc = createSyncedDoc({ store: sessionStore, isConflict: isConfigConflict });

function sign(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("base64url");
}

const credentialsTag = () => sign(`${ADMIN_USER}:${ADMIN_PASSWORD}`).slice(0, 22);
const sessionKey = id => crypto.createHash("sha256").update(id).digest("base64url");

async function refreshSessions() {
  try {
    await sessionsDoc.refresh();
  } catch (e) {
    console.error("[Auth] Sessions refresh failed:", e.message);
  }
}

// An unknown id may be a login made on another server a moment ago: re-read
// the shared file. Callers share one pending re-read, at most one a second, so
// junk cookies only slow down their own answers and can't flood S3.
let lastForcedRefresh = 0;
let pendingRefresh = null;
function refreshSessionsForUnknown() {
  if (!sessionStore.remote) return Promise.resolve();
  if (!pendingRefresh) {
    const wait = Math.max(0, lastForcedRefresh + 1000 - Date.now());
    pendingRefresh = new Promise(r => setTimeout(r, wait))
      .then(() => {
        lastForcedRefresh = Date.now();
        return refreshSessions();
      })
      .finally(() => { pendingRefresh = null; });
  }
  return pendingRefresh;
}

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function getCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// The session's key when the request carries a valid session, else null
async function currentSession(req) {
  if (!ADMIN_USER || !ADMIN_PASSWORD) return null;
  const id = getCookie(req, SESSION_COOKIE);
  if (!id || !SESSION_ID_RE.test(id)) return null;
  const key = sessionKey(id);
  const valid = () => {
    const s = sessionsDoc.get()[key];
    return !!s && safeEqual(s.auth, credentialsTag());
  };
  if (valid()) return key;
  await refreshSessionsForUnknown();
  return valid() ? key : null;
}

function isHttps(req) {
  return req.secure || req.headers["x-forwarded-proto"] === "https";
}

function setSessionCookie(req, res, value, maxAgeSeconds) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`,
  ];
  if (isHttps(req)) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function requireAuth(req, res, next) {
  currentSession(req).then(key => {
    if (key) {
      req.sessionKey = key;
      return next();
    }
    if (req.originalUrl.startsWith("/api/")) return res.status(401).json({ error: "Não autenticado" });
    res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  }, next);
}

// Brute-force guard: lock an IP for a minute after repeated failures
const loginFailures = new Map(); // ip → { count, lockedUntil }

// Standalone QR iframe: follows the totem iframe on the same page (public)
app.get("/qr", (req, res) => res.sendFile(path.join(STATIC_DIR, "qr.html")));

app.get("/login", async (req, res) => {
  if (await currentSession(req)) return res.redirect("/admin");
  res.sendFile(path.join(STATIC_DIR, "login.html"));
});

app.post("/api/login", async (req, res) => {
  if (!ADMIN_USER || !ADMIN_PASSWORD) {
    return res.status(503).json({ error: "Login não configurado (defina ADMIN_USER e ADMIN_PASSWORD no .env)" });
  }

  const ip = req.ip;
  const entry = loginFailures.get(ip);
  if (entry && entry.lockedUntil > Date.now()) {
    const wait = Math.ceil((entry.lockedUntil - Date.now()) / 1000);
    return res.status(429).json({ error: `Muitas tentativas. Tente de novo em ${wait}s.` });
  }

  const { username, password } = req.body || {};
  // Compare both (no short-circuit) so timing doesn't reveal which one was wrong
  const userOk = safeEqual(username || "", ADMIN_USER);
  const passOk = safeEqual(password || "", ADMIN_PASSWORD);
  if (!userOk || !passOk) {
    // An expired lock starts a fresh count
    const count = entry && !entry.lockedUntil ? entry.count + 1 : 1;
    loginFailures.set(ip, { count, lockedUntil: count >= LOGIN_MAX_FAILURES ? Date.now() + LOGIN_LOCK_MS : 0 });
    console.warn(`[Auth] Failed login from ${ip} (${count})`);
    return res.status(401).json({ error: "Usuário ou senha inválidos" });
  }

  loginFailures.delete(ip);
  const id = crypto.randomBytes(32).toString("base64url");
  try {
    await sessionsDoc.mutate(all => {
      all[sessionKey(id)] = { created: new Date().toISOString(), auth: credentialsTag() };
      // Keep the newest MAX_SESSIONS (old forgotten browsers drop off)
      const keys = Object.keys(all).sort((a, b) => String(all[b].created).localeCompare(String(all[a].created)));
      keys.slice(MAX_SESSIONS).forEach(k => delete all[k]);
    });
  } catch (err) {
    console.error("[Auth] Could not save the session:", err.message);
    return res.status(502).json({ error: "Não foi possível iniciar a sessão. Tente de novo." });
  }
  // ~10 years: the session only ends on logout
  setSessionCookie(req, res, id, 10 * 365 * 24 * 3600);
  console.log(`[Auth] ${ADMIN_USER} logged in from ${ip}`);
  res.json({ success: true, user: ADMIN_USER });
});

app.post("/api/logout", async (req, res) => {
  setSessionCookie(req, res, "", 0);
  const key = await currentSession(req);
  try {
    if (key) await sessionsDoc.mutate(all => { delete all[key]; });
  } catch (err) {
    console.error("[Auth] Could not end the session:", err.message);
    return res.status(502).json({ error: "Não foi possível encerrar a sessão no servidor. Tente de novo." });
  }
  res.json({ success: true });
});

// Everything below is admin-only: admin page, API docs and /api/*
app.get("/admin", requireAuth, (req, res) => res.sendFile(path.join(STATIC_DIR, "admin.html")));
app.get("/static/admin.html", (req, res) => res.redirect("/admin"));
// Debug page shows internals (timings, drift): admin only
app.get("/static/mobile_debug.html", requireAuth, (req, res) => res.sendFile(path.join(STATIC_DIR, "mobile_debug.html")));
app.use("/api", requireAuth);
app.use("/api-docs", requireAuth);

app.get("/api/session", (req, res) => res.json({ user: ADMIN_USER }));

// How many browsers are logged in
app.get("/api/sessions", (req, res) => {
  const tag = credentialsTag();
  res.json({ count: Object.values(sessionsDoc.get()).filter(s => s.auth === tag).length });
});

// "Desconectar outros aparelhos": end every session except this one
app.post("/api/sessions/revoke-others", async (req, res) => {
  try {
    const revoked = await sessionsDoc.mutate(all => {
      const others = Object.keys(all).filter(k => k !== req.sessionKey);
      others.forEach(k => delete all[k]);
      return others.length;
    });
    console.log(`[Auth] ${revoked} other session(s) ended`);
    res.json({ success: true, revoked });
  } catch (err) {
    console.error("[Auth] Could not end the sessions:", err.message);
    res.status(502).json({ error: "Não foi possível desconectar os outros aparelhos. Tente de novo." });
  }
});

// ── Statistics ──────────────────────────────────────────────────────────────
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
    console.error("[Stats] Read failed:", err.message);
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
    console.error("[Stats] CSV failed:", err.message);
    res.status(502).json({ error: storageErrorMessage(err) });
  }
});

// ── Swagger UI ──────────────────────────────────────────────────────────────
const swaggerDocument = YAML.parse(fs.readFileSync(path.join(__dirname, 'openapi.yaml'), 'utf8'));
swaggerDocument.servers = [{ url: PUBLIC_URL }];
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// ── API ─────────────────────────────────────────────────────────────────────

// ── Media library (CRUD over assets/) ───────────────────────────────────────
// Turns an arbitrary name into a safe "base.ext" (accents stripped, odd chars → "_")
function sanitizeBaseName(raw) {
  const name = path.basename(String(raw || "")).trim();
  return path.basename(name, path.extname(name))
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^[._]+/, "");
}

function sanitizeFilename(raw) {
  const name = path.basename(String(raw || "")).trim();
  const ext = path.extname(name).toLowerCase();
  const base = sanitizeBaseName(name);
  if (!base || !MEDIA_EXTS.includes(ext)) return null;
  return base + ext;
}

function mediaType(filename) {
  return VIDEO_EXTS.includes(path.extname(filename).toLowerCase()) ? "video" : "audio";
}

// A valid media filename from a route param that exists in the library
function mediaExists(filename) {
  if (!filename || filename.startsWith(".") || /[\\/]/.test(filename) || filename.includes("..")) return false;
  if (!MEDIA_EXTS.includes(path.extname(filename).toLowerCase())) return false;
  return mediaStore.has(filename);
}

function listMedia(type) {
  return mediaStore.list().map(m => m.filename).filter(f => !type || mediaType(f) === type);
}

// Totem ids whose config references this file (in any playlist item)
function totemsUsing(filename) {
  return campaignsUsing(totemsConf, filename);
}

// Message for the admin when the library storage fails
function storageErrorMessage(err) {
  const reason = err && (err.message || err.name) || "erro desconhecido";
  return mediaStore.remote ? `Falha no S3: ${reason}` : `Não foi possível salvar o arquivo: ${reason}`;
}

// Streams the request body into a hidden temp file (in assets/ for the local
// store, in the OS temp folder for S3). Calls onComplete(tmpPath, received, fail)
// once fully written; on any error the temp file is removed and an error is sent.
function streamUploadToTemp(req, res, label, onComplete) {
  const declared = parseInt(req.headers["content-length"], 10);
  if (declared > MAX_UPLOAD_BYTES) {
    return res.status(413).json({ error: `Arquivo grande demais (máximo ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)` });
  }

  fs.mkdirSync(mediaStore.tempDir, { recursive: true });
  const tmpPath = path.join(mediaStore.tempDir, `.upload-${Date.now()}-${label}`);
  const out = fs.createWriteStream(tmpPath);
  let received = 0;
  let failed = false;

  const fail = (code, error) => {
    if (failed) return;
    failed = true;
    req.unpipe(out);
    out.destroy();
    fs.rm(tmpPath, { force: true }, () => {});
    if (!res.headersSent) res.status(code).json({ error });
  };

  req.on("data", chunk => {
    received += chunk.length;
    if (received > MAX_UPLOAD_BYTES) fail(413, "Arquivo grande demais");
  });
  req.on("aborted", () => fail(400, "Envio interrompido"));
  out.on("error", e => {
    console.error("[Media] Write failed", e);
    fail(500, "Não foi possível salvar o arquivo");
  });
  out.on("finish", () => {
    if (failed) return;
    if (received === 0) return fail(400, "Arquivo vazio");
    onComplete(tmpPath, received, fail);
  });

  req.pipe(out);
}

// Saves the request body as <targetName> in the library. Responds with `status` on success.
function receiveUpload(req, res, targetName, status) {
  streamUploadToTemp(req, res, targetName, async (tmpPath, received, fail) => {
    try {
      await mediaStore.putFile(tmpPath, targetName);
    } catch (err) {
      console.error(`[Media] Save ${targetName} failed:`, err.message);
      fs.rm(tmpPath, { force: true }, () => {});
      return fail(502, storageErrorMessage(err));
    }
    const type = mediaType(targetName);
    console.log(`[Media] Saved ${type} ${targetName} (${(received / 1024 / 1024).toFixed(1)} MB)`);
    res.status(status).json({ success: true, filename: targetName, type, size: received });
  });
}


// List: GET /api/media
app.get("/api/media", (req, res) => {
  const status = mediaStore.status();
  if (!status.ok) return res.status(503).json({ error: storageErrorMessage({ message: status.error }) });
  res.json(mediaStore.list().map(m => ({
    filename: m.filename,
    type: mediaType(m.filename),
    size: m.size,
    modified: m.modified ? new Date(m.modified).toISOString() : null,
    used_by: totemsUsing(m.filename),
  })));
});

// Create: POST /api/media?filename=promo.mp4[&overwrite=1]  (raw body)
app.post("/api/media", (req, res) => {
  const filename = sanitizeFilename(req.query.filename);
  if (!filename) {
    return res.status(400).json({ error: `Arquivo inválido. Permitidos: ${MEDIA_EXTS.join(", ")}` });
  }
  const overwrite = req.query.overwrite === "1" || req.query.overwrite === "true";
  if (mediaStore.has(filename) && !overwrite) {
    return res.status(409).json({ error: "O arquivo já existe", filename });
  }
  receiveUpload(req, res, filename, 201);
});

// Direct upload (S3 mode): the browser sends the file straight to the bucket,
// so big videos don't pass through this server.
//   1. POST /api/media/upload-url { filename, size, overwrite?, replace? }
//      → { direct: true, filename, url, headers, expires_in }  (local mode: { direct: false })
//   2. browser PUTs the file to `url` with `headers`
//   3. POST /api/media/upload-complete { filename } → the file joins the library
// `replace` = existing file whose content is replaced (keeps its name).
const DIRECT_UPLOAD_EXPIRES_S = 600;

app.post("/api/media/upload-url", async (req, res) => {
  if (!mediaStore.remote) return res.json({ direct: false });
  const { filename: raw, size, overwrite, replace } = req.body || {};

  let filename;
  if (replace) {
    if (!mediaExists(replace)) return res.status(404).json({ error: "Arquivo não encontrado" });
    const ext = path.extname(String(raw || "")).toLowerCase();
    if (ext !== path.extname(replace).toLowerCase()) {
      return res.status(400).json({ error: `"${replace}" só pode ser substituído por outro arquivo ${path.extname(replace)}` });
    }
    filename = replace;
  } else {
    filename = sanitizeFilename(raw);
    if (!filename) return res.status(400).json({ error: `Arquivo inválido. Permitidos: ${MEDIA_EXTS.join(", ")}` });
    if (mediaStore.has(filename) && !overwrite) return res.status(409).json({ error: "O arquivo já existe", filename });
  }

  if (!Number.isInteger(size) || size <= 0) return res.status(400).json({ error: "Arquivo vazio" });
  if (size > MAX_UPLOAD_BYTES) {
    return res.status(413).json({ error: `Arquivo grande demais (máximo ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)` });
  }

  try {
    const signed = await storage.presignPut(filename, { size, expiresIn: DIRECT_UPLOAD_EXPIRES_S });
    res.json({ direct: true, filename, url: signed.url, headers: signed.headers, expires_in: signed.expiresIn });
  } catch (err) {
    console.error(`[Media] Sign upload ${filename} failed:`, err.message);
    res.status(502).json({ error: storageErrorMessage(err) });
  }
});

app.post("/api/media/upload-complete", async (req, res) => {
  if (!mediaStore.remote) return res.status(400).json({ error: "Envio direto só existe no modo S3" });
  const filename = String((req.body || {}).filename || "");
  if (sanitizeFilename(filename) !== filename) return res.status(400).json({ error: "Arquivo inválido" });
  try {
    const item = await mediaStore.registerUploaded(filename);
    if (!item) return res.status(404).json({ error: "O arquivo não chegou ao S3. Tente enviar de novo." });
    const type = mediaType(filename);
    console.log(`[Media] Saved ${type} ${filename} (${(item.size / 1024 / 1024).toFixed(1)} MB, direct to S3)`);
    res.status(201).json({ success: true, filename, type, size: item.size });
  } catch (err) {
    console.error(`[Media] Register ${filename} failed:`, err.message);
    res.status(502).json({ error: storageErrorMessage(err) });
  }
});

// Split: POST /api/media/split?filename=promo.mov[&overwrite=1]  (raw body)
// Uploads a video WITH audio and saves it as <name>_video.<ext> + <name>_audio.mp3.
// The original upload is not kept.
app.post("/api/media/split", (req, res) => {
  const raw = path.basename(String(req.query.filename || "")).trim();
  const ext = path.extname(raw).toLowerCase();
  const base = sanitizeBaseName(raw);
  if (!base || !SPLIT_INPUT_EXTS.includes(ext)) {
    return res.status(400).json({ error: `Arquivo inválido. Envie um vídeo com áudio: ${SPLIT_INPUT_EXTS.join(", ")}` });
  }

  // Check the likely output names before receiving a possibly large file
  const overwrite = req.query.overwrite === "1" || req.query.overwrite === "true";
  const videoName = `${base}_video${ext === ".webm" ? ".webm" : ".mp4"}`;
  const audioName = `${base}_audio.mp3`;
  const existing = [videoName, audioName].filter(f => mediaStore.has(f));
  if (existing.length && !overwrite) {
    return res.status(409).json({ error: "Já existem arquivos com esses nomes", files: existing });
  }

  streamUploadToTemp(req, res, `${base}${ext}`, async (tmpPath, received) => {
    const started = Date.now();
    // Outputs go to a scratch folder first, then into the library
    const workDir = fs.mkdtempSync(path.join(mediaStore.tempDir, ".split-"));
    try {
      const web = req.query.web === "1" || req.query.web === "true";
      const result = await splitMedia(tmpPath, { outDir: workDir, baseName: base, overwrite: true, web });
      const video = path.basename(result.video);
      const audio = path.basename(result.audio);
      if (!overwrite && (mediaStore.has(video) || mediaStore.has(audio))) {
        return res.status(409).json({ error: "Já existem arquivos com esses nomes", files: [video, audio].filter(f => mediaStore.has(f)) });
      }
      try {
        await mediaStore.putFile(result.video, video);
        await mediaStore.putFile(result.audio, audio);
      } catch (err) {
        console.error("[Media] Split save failed:", err.message);
        return res.status(502).json({ error: storageErrorMessage(err) });
      }
      console.log(`[Media] Split ${raw} (${(received / 1024 / 1024).toFixed(1)} MB) → ${video} + ${audio}` +
        `${result.transcoded ? " (video re-encoded)" : ""} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      res.status(201).json({ success: true, video, audio, transcoded: result.transcoded, web: result.web, duration: result.duration });
    } catch (err) {
      console.error("[Media] Split failed:", err.message);
      const userError = /não tem faixa|não suportado|Já existe/.test(err.message);
      res.status(userError ? 400 : 500).json({
        error: userError ? err.message : "Não foi possível separar o vídeo e o áudio",
      });
    } finally {
      fs.rm(tmpPath, { force: true }, () => {});
      fs.rm(workDir, { recursive: true, force: true }, () => {});
    }
  });
});

// Replace content: PUT /api/media/:filename  (raw body, keeps the name)
app.put("/api/media/:filename", (req, res) => {
  if (!mediaExists(req.params.filename)) return res.status(404).json({ error: "Arquivo não encontrado" });
  receiveUpload(req, res, req.params.filename, 200);
});

// Rename: PATCH /api/media/:filename  { "filename": "new-name.mp4" }
app.patch("/api/media/:filename", async (req, res) => {
  const oldName = req.params.filename;
  if (!mediaExists(oldName)) return res.status(404).json({ error: "Arquivo não encontrado" });

  const newName = sanitizeFilename(req.body && req.body.filename);
  if (!newName) return res.status(400).json({ error: `Nome inválido. Permitidos: ${MEDIA_EXTS.join(", ")}` });
  if (mediaType(newName) !== mediaType(oldName)) {
    return res.status(400).json({ error: `${mediaType(oldName) === "video" ? "Um vídeo precisa continuar com extensão de vídeo" : "Um áudio precisa continuar com extensão de áudio"}` });
  }
  if (newName === oldName) return res.json({ success: true, filename: newName, updated_totems: [] });
  if (mediaStore.has(newName)) {
    return res.status(409).json({ error: "Já existe um arquivo com esse nome", filename: newName });
  }

  try {
    await mediaStore.rename(oldName, newName);
  } catch (e) {
    console.error("[Media] Rename failed", e.message);
    return res.status(502).json({ error: storageErrorMessage(e) });
  }

  // Keep totem configs pointing at the file under its new name
  let updated = [];
  try {
    await refreshConfig();
    if (totemsUsing(oldName).length) {
      // Open screens get the new names (mutateConfig → broadcastContent)
      updated = await mutateConfig(conf => renameInConfig(conf, oldName, newName));
    }
  } catch (err) {
    console.error("[Media] Rename: config update failed", err.message);
    return res.status(502).json({ error: `Arquivo renomeado, mas não foi possível atualizar os totens: ${err.message}` });
  }

  console.log(`[Media] Renamed ${oldName} → ${newName}${updated.length ? ` (totems: ${updated.join(", ")})` : ""}`);
  res.json({ success: true, filename: newName, updated_totems: updated });
});

// Delete: DELETE /api/media/:filename  (refused while a totem uses it)
app.delete("/api/media/:filename", async (req, res) => {
  const filename = req.params.filename;
  if (!mediaExists(filename)) return res.status(404).json({ error: "Arquivo não encontrado" });

  await refreshConfig(); // another server may have just assigned it
  const usedBy = totemsUsing(filename);
  if (usedBy.length) {
    return res.status(409).json({ error: "O arquivo está em uso por um totem", used_by: usedBy });
  }

  try {
    await mediaStore.remove(filename);
  } catch (e) {
    console.error("[Media] Delete failed", e.message);
    return res.status(502).json({ error: storageErrorMessage(e) });
  }
  console.log(`[Media] Deleted ${filename}`);
  res.json({ success: true, filename });
});


// Get totems list & states
app.get("/api/totems", (req, res) => {
  // Saved campaigns + campaigns with open screens that were never saved
  const allIds = new Set([...Object.keys(totemsConf), ...instances.campaignsOnline()]);

  res.json([...allIds].map(id => {
    const { instances: openScreens, mobiles } = instances.stats(id);
    const content = contentFor(id);
    return {
      id,
      configured: !!totemsConf[id], // false = online but never saved in the admin
      is_online: openScreens > 0,
      instances: openScreens,       // screens/iframes playing right now
      mobile_count: mobiles,        // phones listening (drift sockets)
      video: totemsConf[id] ? totemsConf[id].video : null,
      audio: totemsConf[id] ? totemsConf[id].audio : null,
      playlist: playlistOf(totemsConf[id]),     // videos in order, each with its audio
      schedule: (totemsConf[id] && totemsConf[id].schedule) || null,
      showing: content ? content.source : null, // own id, the fallback's, or null (nothing on air)
      missing: missingMedia(totemsConf[id]), // configured files not in the library
      promo: promoFor(id),
    };
  }));
});

// Promo options for the admin editor (icon list, limits, defaults)
app.get("/api/promo/options", (req, res) => {
  res.json({ icons: PROMO_ICONS, max_links: PROMO_MAX_LINKS, defaults: DEFAULT_PROMO });
});

// Update the mobile page text/links for a totem
app.put("/api/totem/:id/promo", async (req, res) => {
  const { id } = req.params;
  const { promo, error } = sanitizePromo(req.body);
  if (error) return res.status(400).json({ error });

  try {
    await mutateConfig(conf => {
      if (!conf[id]) conf[id] = {};
      conf[id].promo = promo;
    });
  } catch (err) {
    return sendError(res, err, "Admin");
  }

  console.log(`[Admin] Updated mobile links for totem ${id} (${promo.links.length} links)`);
  res.json({ success: true, id, promo });
});

// Update specific totem's config: { playlist: [{ video, audio }] } or { video, audio }
app.post("/api/totem/:id/config", async (req, res) => {
  const { id } = req.params;
  const body = req.body || {};
  const input = Array.isArray(body.playlist) ? body.playlist : [{ video: body.video, audio: body.audio }];
  if (!input.length || !input.every(i => i && i.video && i.audio)) {
    return res.status(400).json({ error: "Escolha um vídeo e um áudio" });
  }
  const { playlist, error } = sanitizePlaylist(input, mediaLibrary());
  if (error) return res.status(400).json({ error });

  try {
    await mutateConfig(conf => {
      conf[id] = withPlaylist(conf[id] || {}, playlist);
    });
  } catch (err) {
    return sendError(res, err, "Admin");
  }

  // Open screens switch right away (mutateConfig → broadcastContent)
  console.log(`[Admin] Assigned ${playlist.map(i => `${i.video}+${i.audio}`).join(", ")} to totem ${id}`);
  res.json({ success: true, id, video: playlist[0].video, audio: playlist[0].audio, playlist });
});

// ── Totems CRUD ─────────────────────────────────────────────────────────────
// IDs go into URLs (?screen=ID) and the admin markup, so keep them simple
const TOTEM_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

// Files a totem config references that aren't in the library (e.g. renamed or
// deleted by another server sharing the bucket). Empty while the library is
// unavailable, to avoid false alarms.
function missingMedia(conf) {
  if (!conf || !mediaStore.status().ok) return [];
  const files = [conf.video, conf.audio, ...playlistOf(conf).flatMap(i => [i.video, i.audio])];
  return [...new Set(files)].filter(f => f && !mediaStore.has(f));
}

const mediaLibrary = () => ({ videos: listMedia("video"), audios: listMedia("audio") });

// The playlist / schedule of a create or update request → { playlist?, schedule? }
// (absent = not sent), or { error }
function campaignFields(body, id, campaignIds) {
  const out = {};
  if (body.playlist !== undefined) {
    const r = sanitizePlaylist(body.playlist, mediaLibrary());
    if (r.error) return { error: r.error };
    out.playlist = r.playlist;
  } else {
    const err = validateTotemMedia(body.video, body.audio);
    if (err) return { error: err };
  }
  if (body.schedule !== undefined) {
    const r = sanitizeSchedule(body.schedule, id, campaignIds);
    if (r.error) return { error: r.error };
    out.schedule = r.schedule;
  }
  return out;
}

function applyCampaignFields(conf, body, fields) {
  let next = { ...conf };
  if (fields.playlist) {
    next = withPlaylist(next, fields.playlist);
  } else {
    if (body.video !== undefined) next.video = body.video || "";
    if (body.audio !== undefined) next.audio = body.audio || "";
    // Editing the first video/audio the old way keeps the rest of the playlist
    if (Array.isArray(next.playlist) && next.playlist.length) {
      next.playlist = [{ video: next.video, audio: next.audio }, ...next.playlist.slice(1)];
    }
  }
  if (fields.schedule !== undefined) {
    if (fields.schedule) next.schedule = fields.schedule;
    else delete next.schedule;
  }
  return next;
}

// Checks optional video/audio fields against the library. Returns an error string or null.
function validateTotemMedia(video, audio) {
  if (video && !listMedia("video").includes(video)) return `Vídeo não encontrado: ${video}`;
  if (audio && !listMedia("audio").includes(audio)) return `Áudio não encontrado: ${audio}`;
  return null;
}

// Create: POST /api/totems  { id, video?, audio?, playlist?, schedule? }
app.post("/api/totems", async (req, res) => {
  const body = req.body || {};
  const { id } = body;
  if (!TOTEM_ID_RE.test(id || "")) {
    return res.status(400).json({ error: "O ID deve ter de 1 a 40 letras, números, - ou _" });
  }
  const fields = campaignFields(body, id, Object.keys(totemsConf));
  if (fields.error) return res.status(400).json({ error: fields.error });

  let created;
  try {
    await mutateConfig(conf => {
      if (conf[id]) throw new HttpError(409, `O totem "${id}" já existe`);
      created = applyCampaignFields({ video: "", audio: "" }, body, fields);
      conf[id] = created;
    });
  } catch (err) {
    return sendError(res, err, "Admin");
  }
  // Screens already open under this ID pick up the video right away (broadcastContent)
  console.log(`[Admin] Created totem ${id}`);
  res.status(201).json({ success: true, id, ...created, playlist: playlistOf(created) });
});

// Update: PATCH /api/totem/:id  { id?, video?, audio? }  — `id` renames the totem
app.patch("/api/totem/:id", async (req, res) => {
  const oldId = req.params.id;
  const body = req.body || {};
  const newId = body.id === undefined ? oldId : String(body.id).trim();
  if (!TOTEM_ID_RE.test(newId)) {
    return res.status(400).json({ error: "O ID deve ter de 1 a 40 letras, números, - ou _" });
  }
  const ids = Object.keys(totemsConf).map(k => (k === oldId ? newId : k));
  const fields = campaignFields(body, newId, ids);
  if (fields.error) return res.status(400).json({ error: fields.error });

  let conf;
  try {
    conf = await mutateConfig(all => {
      if (!all[oldId]) throw new HttpError(404, "Totem não encontrado");
      if (newId !== oldId && all[newId]) throw new HttpError(409, `O totem "${newId}" já existe`);
      const next = applyCampaignFields(all[oldId], body, fields);
      if (newId !== oldId) {
        delete all[oldId];
        // Campaigns falling back to this one follow the new name
        for (const c of Object.values(all)) {
          if (c.schedule && c.schedule.fallback === oldId) c.schedule = { ...c.schedule, fallback: newId };
        }
      }
      all[newId] = next;
      return next;
    });
  } catch (err) {
    return sendError(res, err, "Admin");
  }

  // Content changes reach open screens through mutateConfig → broadcastContent
  if (newId !== oldId) {
    // Every open screen reloads itself with ?screen=<newId>
    sendToCampaign(oldId, { type: "change_screen", screen: newId });
  }

  console.log(`[Admin] Updated totem ${oldId}${newId !== oldId ? ` → ${newId}` : ""}`);
  res.json({ success: true, id: newId, renamed_from: newId !== oldId ? oldId : undefined, ...conf, playlist: playlistOf(conf) });
});

// Delete: DELETE /api/totem/:id  — removes the saved config (video, audio, links)
app.delete("/api/totem/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await mutateConfig(conf => {
      if (!conf[id]) throw new HttpError(404, "Totem não encontrado");
      delete conf[id];
      // Campaigns falling back to it now show nothing outside their period
      for (const c of Object.values(conf)) {
        if (c.schedule && c.schedule.fallback === id) c.schedule = { ...c.schedule, fallback: null };
      }
    });
  } catch (err) {
    return sendError(res, err, "Admin");
  }
  console.log(`[Admin] Deleted totem ${id}`);
  res.json({ success: true, id, still_online: instances.online(id).length > 0 });
});

// ── Health check ────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  const t = instances.totals();
  res.json({
    status: "ok",
    server_time: Date.now() / 1000,
    sessions: t.instances,      // instances kept in memory (open + recently closed)
    screens_online: t.online,
    mobile_clients: t.mobiles,
    uptime_s: Math.round(process.uptime()),
    memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  });
});

// ── Media streaming with Range support ──────────────────────────────────────
app.get("/media/:filename", (req, res) => {
  const filename = req.params.filename;

  if (filename.startsWith(".") || filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    return res.status(400).json({ error: "Nome de arquivo inválido" });
  }

  // S3-only: files live in the bucket — send old links / admin previews there
  if (mediaStore.remote) return res.redirect(302, mediaUrl(filename));

  const filePath = mediaStore.localPath(filename);

  if (!filePath) {
    return res.status(404).json({ error: "Arquivo não encontrado" });
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const ext = path.extname(filename).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  // No cache lifetime: clients always revalidate (cheap 304 via ETag), so a
  // replaced or renamed file is picked up on the next request.
  const etag = `"${fileSize.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const cacheHeaders = {
    "Cache-Control": "no-cache",
    "ETag": etag,
    "Last-Modified": stat.mtime.toUTCString(),
  };

  // If-Range with a stale validator → send the whole (new) file instead of a range
  const ifRange = req.headers["if-range"];
  const range = ifRange && ifRange !== etag ? null : req.headers.range;

  if (!range && req.headers["if-none-match"] === etag) {
    res.writeHead(304, cacheHeaders);
    return res.end();
  }

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (start >= fileSize) {
      return res.status(416).header("Content-Range", `bytes */${fileSize}`).end();
    }

    const chunkSize = end - start + 1;

    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkSize,
      "Content-Type": contentType,
      ...cacheHeaders,
    });

    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      "Content-Length": fileSize,
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      ...cacheHeaders,
    });

    fs.createReadStream(filePath).pipe(res);
  }
});

// ── Static files ────────────────────────────────────────────────────────────
app.use("/static", express.static(STATIC_DIR));

// ── WebSocket server ────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

// ── WS route matching ───────────────────────────────────────────────────────
const screensPerIp = new Map(); // ip → open screen sockets
const phonesPerIp = new Map();  // ip → open drift sockets (phones listening)
const syncsPerIp = new Map();   // ip → { count, windowStart } (sync attempts per minute)

// Fixed one-minute window per IP; returns false when over the limit
function allowSync(ip) {
  const now = Date.now();
  const entry = syncsPerIp.get(ip);
  if (!entry || now - entry.windowStart >= 60000) {
    syncsPerIp.set(ip, { count: 1, windowStart: now });
    return true;
  }
  entry.count++;
  return entry.count <= MAX_SYNCS_PER_IP_PER_MINUTE;
}
// Forget idle windows so the map doesn't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of syncsPerIp) if (now - e.windowStart >= 60000) syncsPerIp.delete(ip);
}, 60000).unref();

function clientIp(req) {
  if (TRUST_PROXY && req.headers["x-forwarded-for"]) {
    return String(req.headers["x-forwarded-for"]).split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

// Without TRUST_PROXY, everything behind a local tunnel looks like loopback:
// we can't tell visitors apart, so the per-IP limit doesn't apply to it
function isLoopback(ip) {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

server.on("upgrade", (req, socket, head) => {
  const parsed = url.parse(req.url, true);
  const match = parsed.pathname.match(/^\/ws\/(screen|mobile|drift)\/([^/]+)$/);
  if (!match) return socket.destroy();

  req._wsRoute = match[1];
  req._screenId = match[2];                         // campaign (totem ID)
  req._instanceId = String(parsed.query.instance || "");
  req._ip = clientIp(req);
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

// ── WS connection handler ───────────────────────────────────────────────────
wss.on("connection", (ws, req) => {
  const route = req._wsRoute;
  const campaign = req._screenId;
  const instanceId = req._instanceId;

  if (route === "screen") handleScreen(ws, campaign, instanceId, req._ip);
  else if (route === "mobile") handleMobile(ws, campaign, instanceId, req._ip);
  else if (route === "drift") handleDrift(ws, campaign, instanceId, req._ip);
});

// ── /ws/screen/:campaign?instance=ID — a screen playing the campaign ────────
// Stays open: receives change_video / change_screen / mobile_connected.
function handleScreen(ws, campaign, instanceId, ip) {
  const reconnecting = !!instances.get(campaign, instanceId);
  if (!reconnecting && instances.online(campaign).length >= MAX_INSTANCES_PER_CAMPAIGN) {
    ws.close(4029, "Campaign screen limit");
    return;
  }
  const limitIp = TRUST_PROXY || !isLoopback(ip);
  if (limitIp && (screensPerIp.get(ip) || 0) >= MAX_SCREENS_PER_IP) {
    ws.close(4029, "Too many screens from this address");
    return;
  }
  screensPerIp.set(ip, (screensPerIp.get(ip) || 0) + 1);

  const inst = instances.register(campaign, instanceId, ws);
  console.log(`[Screen] ${campaign}/${inst.id} connected`);
  // A new screen counts once (reconnects of the same instance don't)
  let counted = reconnecting;

  ws.on("message", (raw) => {
    try {
      const data = JSON.parse(raw);

      if (data.type === "position_update") {
        // Periodic position: recalculate start_time with the SERVER clock
        instances.updatePosition(inst, data.current_time);
        return;
      }

      if (!counted) {
        counted = true;
        stats.screenOpened(campaign, data.site);
      }

      // Registration: the screen sends its position in the whole cycle
      // (current_time), the cycle length (duration) and, for playlists, the
      // length of each video (items). Sent again whenever it loads new content.
      const hadSession = !!inst.session;
      const session = instances.startSession(inst, data);
      session.items = itemDurations(data.items, session.duration);
      console.log(`[Screen] Session ${campaign}/${inst.id} — ${session.duration}s` +
        `${session.items ? ` (${session.items.length} videos)` : ""} (pos: ${(Number(data.current_time) || 0).toFixed(2)}s)`);
      safeSend(ws, { type: "session_created", screen_id: campaign, instance: inst.id });
      // Phones already listening must follow the new timeline
      if (hadSession) notifyPhones(inst);

      // Tell the screen what to play
      const msg = videoMessage(campaign);
      sentContentKeys.set(campaign, msg.key);
      safeSend(ws, msg);
    } catch (err) {
      safeSend(ws, { type: "error", detail: err.message });
    }
  });

  // Heartbeat to keep connection alive
  const pingInterval = setInterval(() => {
    if (ws.readyState === 1) ws.ping();
    else clearInterval(pingInterval);
  }, 30000);

  ws.on("error", () => {});
  ws.on("close", () => {
    clearInterval(pingInterval);
    instances.disconnect(inst, ws);
    const left = (screensPerIp.get(ip) || 1) - 1;
    if (left > 0) screensPerIp.set(ip, left);
    else screensPerIp.delete(ip);
    console.log(`[Screen] ${campaign}/${inst.id} disconnected`);
  });
}

// Video lengths a screen reports for its playlist (≤ 20 positive numbers that
// add up to the cycle); null when missing or inconsistent
function itemDurations(raw, total) {
  if (!Array.isArray(raw) || !raw.length || raw.length > 20) return null;
  const list = raw.map(Number);
  if (!list.every(d => Number.isFinite(d) && d > 0)) return null;
  const sum = list.reduce((a, b) => a + b, 0);
  return Math.abs(sum - total) < 0.5 ? list : null;
}

// The phone's timeline: each item's audio with its start and length in the
// cycle. Without lengths from the screen (older page, or it hasn't reloaded
// the new playlist yet), the first audio spans the whole cycle.
function phoneItems(playlist, session) {
  const durations = session.items && session.items.length === playlist.length ? session.items : null;
  if (!durations) return [{ audio: mediaUrl(playlist[0].audio), start: 0, duration: session.duration }];
  let start = 0;
  return playlist.map((item, i) => {
    const entry = { audio: mediaUrl(item.audio), start, duration: durations[i] };
    start += durations[i];
    return entry;
  });
}

// ── /ws/mobile/:campaign?instance=ID — phone sync (fire-and-close) ──────────
function handleMobile(ws, campaign, instanceId, ip) {
  if ((TRUST_PROXY || !isLoopback(ip)) && !allowSync(ip)) {
    ws.close(4029, "Too many syncs from this address");
    return;
  }
  const inst = instances.resolve(campaign, instanceId);
  if (!inst) {
    safeSend(ws, { type: "error", detail: "Session not found" });
    ws.close(4004, "Session not found");
    return;
  }

  // Nothing on air (outside the period, no fallback): the phone waits
  const content = contentFor(campaign);
  if (!content) {
    safeSend(ws, { type: "idle" });
    ws.close(4010, "Nothing on air");
    return;
  }

  // Send sync payload — NEVER send current_position
  safeSend(ws, {
    type: "sync",
    instance: inst.id,               // phone uses it for the drift socket
    start_time: inst.session.start_time,
    duration: inst.session.duration, // whole cycle (all videos)
    server_time: Date.now() / 1000,
    drift_enabled: inst.session.drift_enabled,
    audio: mediaUrl(content.playlist[0].audio), // first item (older pages)
    items: phoneItems(content.playlist, inst.session),
    promo: promoFor(content.source),
  });

  stats.scan(campaign);
  // Only the scanned screen hides its QR
  if (inst.ws) safeSend(inst.ws, { type: "mobile_connected" });

  ws.close(1000, "Sync delivered");
  ws.on("error", () => {});
}

// ── /ws/drift/:campaign?instance=ID — drift correction for one phone ───────
function handleDrift(ws, campaign, instanceId, ip) {
  const limitIp = TRUST_PROXY || !isLoopback(ip);
  if (limitIp && (phonesPerIp.get(ip) || 0) >= MAX_PHONES_PER_IP) {
    ws.close(4029, "Too many phones from this address");
    return;
  }
  const inst = instances.resolve(campaign, instanceId);
  if (!inst) {
    safeSend(ws, { type: "error", detail: "Session not found" });
    ws.close(4004, "Session not found");
    return;
  }
  if (inst.drifts.size >= MAX_MOBILE_PER_SCREEN) {
    safeSend(ws, { type: "error", detail: "Too many drift connections" });
    ws.close(4029, "Too many connections");
    return;
  }

  inst.drifts.add(ws);
  phonesPerIp.set(ip, (phonesPerIp.get(ip) || 0) + 1);
  const listeningSince = Date.now();
  stats.listenStart(campaign);

  const interval = setInterval(() => {
    const session = inst.session;
    if (!session || ws.readyState !== 1) {
      clearInterval(interval);
      return;
    }
    const now = Date.now() / 1000;
    const expectedPosition =
      ((now - session.start_time) % session.duration + session.duration) % session.duration;

    safeSend(ws, {
      type: "drift_check",
      expected_position: expectedPosition,
      server_time: now,
      start_time: session.start_time,
      duration: session.duration,
      threshold_ms: DRIFT_THRESHOLD_MS,
    });
  }, DRIFT_INTERVAL_MS);

  ws.on("message", (raw) => {
    try {
      const data = JSON.parse(raw);
      if (data.type === "position_report" && inst.session) {
        const correction = computeCorrection(data.position, inst.session.start_time, inst.session.duration);
        safeSend(ws, correction || { type: "drift_ok" });
      }
    } catch (_) {}
  });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return; // "error" and "close" can both fire
    cleaned = true;
    clearInterval(interval);
    inst.drifts.delete(ws);
    stats.listenEnd(campaign, (Date.now() - listeningSince) / 1000);
    const left = (phonesPerIp.get(ip) || 1) - 1;
    if (left > 0) phonesPerIp.set(ip, left);
    else phonesPerIp.delete(ip);
  };
  ws.on("error", cleanup);
  ws.on("close", cleanup);
}

// ── Drift correction logic ──────────────────────────────────────────────────
function computeCorrection(clientPosition, startTime, duration) {
  const now = Date.now() / 1000;
  const expected = ((now - startTime) % duration + duration) % duration;

  let drift = clientPosition - expected;

  // Handle wrap-around
  if (Math.abs(drift) > duration / 2) {
    drift = drift > 0 ? drift - duration : drift + duration;
  }

  const driftMs = Math.abs(drift) * 1000;

  if (driftMs <= DRIFT_THRESHOLD_MS) return null;

  if (driftMs > 500) {
    return {
      type: "drift_correction",
      mode: "HARD",
      target_time: expected,
      drift_ms: Math.round(driftMs),
    };
  } else {
    return {
      type: "drift_correction",
      mode: "SOFT",
      playback_rate: drift > 0 ? 0.97 : 1.03,
      drift_ms: Math.round(driftMs),
    };
  }
}

// ── Start server ────────────────────────────────────────────────────────────
// Load the media library first (the bucket listing in S3 mode), then listen
// Never start with an empty config by mistake: retry a few times, then give up
async function loadWithRetry(doc, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      return await doc.load();
    } catch (err) {
      if (i >= attempts) throw err;
      console.warn(`[Config] Load failed (${err.message}) — retrying (${i}/${attempts - 1})`);
      await new Promise(r => setTimeout(r, 1000 * i));
    }
  }
}

Promise.all([
  mediaStore.init(),
  loadWithRetry(configDoc).then(conf => { totemsConf = conf; }),
  loadWithRetry(sessionsDoc),
]).catch(err => {
  console.error(`\n  ❌ Could not load the campaigns config / admin sessions (${configStore.describe()}): ${err.message}\n`);
  process.exit(1);
}).then(() => server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n  🎬 OOH Audio Sync running on http://0.0.0.0:${PORT}`);
  console.log(`  📺 Totem:  ${PUBLIC_URL}/static/totem.html?screen=totem1`);
  console.log(`  ⚙️  Admin:  ${PUBLIC_URL}/admin`);
  console.log(`  📱 Mobile: ${PUBLIC_URL}/static/mobile.html?screen=totem1`);
  console.log(`  🔧 Debug:  ${PUBLIC_URL}/static/mobile_debug.html?screen=totem1 (admin login)`);
  console.log(`  ❤️  Health: ${PUBLIC_URL}/health`);
  console.log(`  📖 Docs:   ${PUBLIC_URL}/api-docs\n`);
  const status = mediaStore.status();
  if (mediaStore.remote) {
    console.log(`  ☁️  Media library: ${mediaStore.describe()} (${mediaStore.list().length} files) — served from ${MEDIA_BASE_URL}\n`);
    if (!status.ok) console.error(`  ❌ Could not list the S3 bucket: ${status.error}\n`);
    // Pick up changes made outside the admin (console, s3-sync, another server)
    setInterval(() => mediaStore.refresh(), 60000).unref();
    console.log(`  🗂️  Campaigns config: ${configStore.describe()} (${Object.keys(totemsConf).length} campaigns, shared by every server on this bucket/prefix)\n`);
    setInterval(refreshConfig, CONFIG_REFRESH_MS).unref();
    setInterval(refreshSessions, CONFIG_REFRESH_MS).unref();
  } else {
    console.log(`  📁 Media library: ${mediaStore.describe()} (${mediaStore.list().length} files)\n`);
  }
  if (!ADMIN_USER || !ADMIN_PASSWORD) {
    console.warn("  ⚠️  ADMIN_USER / ADMIN_PASSWORD not set in .env — admin login is disabled\n");
  }
  if (!process.env.SESSION_SECRET) {
    console.warn("  ⚠️  SESSION_SECRET not set in .env — admin sessions end when the server restarts\n");
  }
}));

// Restart/deploy (pm2, systemd, Ctrl+C): save the last minute of statistics first
let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (shuttingDown) process.exit(0);
    shuttingDown = true;
    const timeout = setTimeout(() => process.exit(0), 5000);
    flushStats().finally(() => {
      clearTimeout(timeout);
      process.exit(0);
    });
  });
}
