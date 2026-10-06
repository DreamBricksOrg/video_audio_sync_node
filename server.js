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
const YAML = require("yamljs");
const { splitMedia, INPUT_EXTS: SPLIT_INPUT_EXTS } = require("./lib/media-splitter");
const { createInstanceRegistry } = require("./lib/instances");
const { writeJsonAtomic } = require("./lib/atomic-write");

// ── Config ──────────────────────────────────────────────────────────────────
// Load .env (Node >= 20.12 built-in); real env vars take precedence
try {
  process.loadEnvFile(path.join(__dirname, ".env"));
} catch (_) {}

const PORT = process.env.PORT || 8001;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
const DRIFT_THRESHOLD_MS = 80;
const DRIFT_INTERVAL_MS = 2000;
const MAX_MOBILE_PER_SCREEN = 50;
// Abuse protection for public embeds
const MAX_SCREENS_PER_IP = parseInt(process.env.MAX_SCREENS_PER_IP, 10) || 20;
const MAX_INSTANCES_PER_CAMPAIGN = parseInt(process.env.MAX_INSTANCES_PER_CAMPAIGN, 10) || 2000;
// Behind a proxy/tunnel (ngrok, Nginx, Cloudflare) set TRUST_PROXY=1 to use X-Forwarded-For
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const ASSETS_DIR = path.join(__dirname, "assets");
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

// What a screen needs to play a campaign: the video, plus the audio for "Ouvir aqui"
function videoMessage(campaign) {
  const conf = totemsConf[campaign] || {};
  return {
    type: "change_video",
    filename: conf.video || "",
    audio: conf.audio ? `/media/${conf.audio}` : null,
  };
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

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, PATCH, DELETE");
  next();
});

// JSON parsing
app.use(bodyParser.json());

// ── Totems configuration sync ───────────────────────────────────────────────
function loadTotemsConf() {
  if (fs.existsSync(TOTEMS_FILE)) {
    try {
      const data = fs.readFileSync(TOTEMS_FILE, 'utf-8');
      return JSON.parse(data);
    } catch (e) {
      console.error("Failed to parse totems.json", e);
    }
  }
  return {};
}

function saveTotemsConf(conf) {
  try {
    // Temp file + rename: a crash mid-write can't corrupt the config
    writeJsonAtomic(TOTEMS_FILE, conf);
  } catch (e) {
    console.error("Failed to write to totems.json", e);
  }
}

// Map from totem Id => configuration { video: "video.mp4" }
let totemsConf = loadTotemsConf();

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
// Stateless signed cookie, valid until logout. The signature includes the
// password, so changing ADMIN_PASSWORD (or SESSION_SECRET) logs everyone out.
function sign(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("base64url");
}

function makeSessionToken(user) {
  return `${Buffer.from(user).toString("base64url")}.${sign(`${user}:${ADMIN_PASSWORD}`)}`;
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

function isAuthenticated(req) {
  if (!ADMIN_USER || !ADMIN_PASSWORD) return false;
  const token = getCookie(req, SESSION_COOKIE);
  return !!token && safeEqual(token, makeSessionToken(ADMIN_USER));
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
  if (isAuthenticated(req)) return next();
  if (req.originalUrl.startsWith("/api/")) return res.status(401).json({ error: "Não autenticado" });
  res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

// Brute-force guard: lock an IP for a minute after repeated failures
const loginFailures = new Map(); // ip → { count, lockedUntil }

app.get("/login", (req, res) => {
  if (isAuthenticated(req)) return res.redirect("/admin");
  res.sendFile(path.join(STATIC_DIR, "login.html"));
});

app.post("/api/login", (req, res) => {
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
  // ~10 years: the session only ends on logout
  setSessionCookie(req, res, makeSessionToken(ADMIN_USER), 10 * 365 * 24 * 3600);
  console.log(`[Auth] ${ADMIN_USER} logged in from ${ip}`);
  res.json({ success: true, user: ADMIN_USER });
});

app.post("/api/logout", (req, res) => {
  setSessionCookie(req, res, "", 0);
  res.json({ success: true });
});

// Everything below is admin-only: admin page, API docs and /api/*
app.get("/admin", requireAuth, (req, res) => res.sendFile(path.join(STATIC_DIR, "admin.html")));
app.get("/static/admin.html", (req, res) => res.redirect("/admin"));
app.use("/api", requireAuth);
app.use("/api-docs", requireAuth);

app.get("/api/session", (req, res) => res.json({ user: ADMIN_USER }));

// ── Swagger UI ──────────────────────────────────────────────────────────────
const swaggerDocument = YAML.load(path.join(__dirname, 'openapi.yaml'));
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

// Resolves an existing media file from a route param, or null
function existingMediaPath(filename) {
  if (!filename || filename.startsWith(".") || /[\/]/.test(filename) || filename.includes("..")) return null;
  if (!MEDIA_EXTS.includes(path.extname(filename).toLowerCase())) return null;
  const filePath = path.join(ASSETS_DIR, filename);
  return fs.existsSync(filePath) ? filePath : null;
}

function listMedia(type) {
  if (!fs.existsSync(ASSETS_DIR)) return [];
  return fs.readdirSync(ASSETS_DIR)
    .filter(f => !f.startsWith(".") && MEDIA_EXTS.includes(path.extname(f).toLowerCase()))
    .filter(f => !type || mediaType(f) === type)
    .sort((a, b) => a.localeCompare(b));
}

// Totem ids whose config references this file
function totemsUsing(filename) {
  return Object.keys(totemsConf).filter(id =>
    totemsConf[id].video === filename || totemsConf[id].audio === filename);
}

// Streams the request body into a hidden temp file in assets/ (listings skip
// dotfiles). Calls onComplete(tmpPath, received, fail) once fully written;
// on any error the temp file is removed and an error response is sent.
function streamUploadToTemp(req, res, label, onComplete) {
  const declared = parseInt(req.headers["content-length"], 10);
  if (declared > MAX_UPLOAD_BYTES) {
    return res.status(413).json({ error: `Arquivo grande demais (máximo ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)` });
  }

  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  const tmpPath = path.join(ASSETS_DIR, `.upload-${Date.now()}-${label}`);
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

// Saves the request body as assets/<targetName>. Responds with `status` on success.
function receiveUpload(req, res, targetName, status) {
  streamUploadToTemp(req, res, targetName, (tmpPath, received, fail) => {
    fs.rename(tmpPath, path.join(ASSETS_DIR, targetName), err => {
      if (err) {
        console.error("[Media] Rename failed", err);
        return fail(500, "Não foi possível salvar o arquivo");
      }
      const type = mediaType(targetName);
      console.log(`[Media] Saved ${type} ${targetName} (${(received / 1024 / 1024).toFixed(1)} MB)`);
      res.status(status).json({ success: true, filename: targetName, type, size: received });
    });
  });
}

app.get("/api/videos", (req, res) => res.json(listMedia("video")));
app.get("/api/audios", (req, res) => res.json(listMedia("audio")));

// List: GET /api/media
app.get("/api/media", (req, res) => {
  res.json(listMedia().map(filename => {
    const stat = fs.statSync(path.join(ASSETS_DIR, filename));
    return {
      filename,
      type: mediaType(filename),
      size: stat.size,
      modified: stat.mtime.toISOString(),
      used_by: totemsUsing(filename),
    };
  }));
});

// Create: POST /api/media?filename=promo.mp4[&overwrite=1]  (raw body)
app.post("/api/media", (req, res) => {
  const filename = sanitizeFilename(req.query.filename);
  if (!filename) {
    return res.status(400).json({ error: `Arquivo inválido. Permitidos: ${MEDIA_EXTS.join(", ")}` });
  }
  const overwrite = req.query.overwrite === "1" || req.query.overwrite === "true";
  if (fs.existsSync(path.join(ASSETS_DIR, filename)) && !overwrite) {
    return res.status(409).json({ error: "O arquivo já existe", filename });
  }
  receiveUpload(req, res, filename, 201);
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
  const existing = [videoName, audioName].filter(f => fs.existsSync(path.join(ASSETS_DIR, f)));
  if (existing.length && !overwrite) {
    return res.status(409).json({ error: "Já existem arquivos com esses nomes", files: existing });
  }

  streamUploadToTemp(req, res, `${base}${ext}`, async (tmpPath, received) => {
    const started = Date.now();
    try {
      const web = req.query.web === "1" || req.query.web === "true";
      const result = await splitMedia(tmpPath, { outDir: ASSETS_DIR, baseName: base, overwrite, web });
      const video = path.basename(result.video);
      const audio = path.basename(result.audio);
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
    }
  });
});

// Replace content: PUT /api/media/:filename  (raw body, keeps the name)
app.put("/api/media/:filename", (req, res) => {
  if (!existingMediaPath(req.params.filename)) return res.status(404).json({ error: "Arquivo não encontrado" });
  receiveUpload(req, res, req.params.filename, 200);
});

// Rename: PATCH /api/media/:filename  { "filename": "new-name.mp4" }
app.patch("/api/media/:filename", (req, res) => {
  const oldName = req.params.filename;
  const oldPath = existingMediaPath(oldName);
  if (!oldPath) return res.status(404).json({ error: "Arquivo não encontrado" });

  const newName = sanitizeFilename(req.body && req.body.filename);
  if (!newName) return res.status(400).json({ error: `Nome inválido. Permitidos: ${MEDIA_EXTS.join(", ")}` });
  if (mediaType(newName) !== mediaType(oldName)) {
    return res.status(400).json({ error: `${mediaType(oldName) === "video" ? "Um vídeo precisa continuar com extensão de vídeo" : "Um áudio precisa continuar com extensão de áudio"}` });
  }
  if (newName === oldName) return res.json({ success: true, filename: newName, updated_totems: [] });
  if (fs.existsSync(path.join(ASSETS_DIR, newName))) {
    return res.status(409).json({ error: "Já existe um arquivo com esse nome", filename: newName });
  }

  try {
    fs.renameSync(oldPath, path.join(ASSETS_DIR, newName));
  } catch (e) {
    console.error("[Media] Rename failed", e);
    return res.status(500).json({ error: "Não foi possível renomear o arquivo" });
  }

  // Keep totem configs pointing at the file under its new name
  const updated = totemsUsing(oldName);
  updated.forEach(id => {
    if (totemsConf[id].video === oldName) totemsConf[id].video = newName;
    if (totemsConf[id].audio === oldName) totemsConf[id].audio = newName;
  });
  if (updated.length) saveTotemsConf(totemsConf);
  // After the config is updated, so the message carries the new names
  updated.forEach(id => sendToCampaign(id, videoMessage(id)));

  console.log(`[Media] Renamed ${oldName} → ${newName}${updated.length ? ` (totems: ${updated.join(", ")})` : ""}`);
  res.json({ success: true, filename: newName, updated_totems: updated });
});

// Delete: DELETE /api/media/:filename  (refused while a totem uses it)
app.delete("/api/media/:filename", (req, res) => {
  const filename = req.params.filename;
  const filePath = existingMediaPath(filename);
  if (!filePath) return res.status(404).json({ error: "Arquivo não encontrado" });

  const usedBy = totemsUsing(filename);
  if (usedBy.length) {
    return res.status(409).json({ error: "O arquivo está em uso por um totem", used_by: usedBy });
  }

  try {
    fs.unlinkSync(filePath);
  } catch (e) {
    console.error("[Media] Delete failed", e);
    return res.status(500).json({ error: "Não foi possível excluir o arquivo" });
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
    return {
      id,
      configured: !!totemsConf[id], // false = online but never saved in the admin
      is_online: openScreens > 0,
      instances: openScreens,       // screens/iframes playing right now
      mobile_count: mobiles,        // phones listening (drift sockets)
      video: totemsConf[id] ? totemsConf[id].video : null,
      audio: totemsConf[id] ? totemsConf[id].audio : null,
      promo: promoFor(id),
    };
  }));
});

// Promo options for the admin editor (icon list, limits, defaults)
app.get("/api/promo/options", (req, res) => {
  res.json({ icons: PROMO_ICONS, max_links: PROMO_MAX_LINKS, defaults: DEFAULT_PROMO });
});

// Update the mobile page text/links for a totem
app.put("/api/totem/:id/promo", (req, res) => {
  const { id } = req.params;
  const { promo, error } = sanitizePromo(req.body);
  if (error) return res.status(400).json({ error });

  if (!totemsConf[id]) totemsConf[id] = {};
  totemsConf[id].promo = promo;
  saveTotemsConf(totemsConf);

  console.log(`[Admin] Updated mobile links for totem ${id} (${promo.links.length} links)`);
  res.json({ success: true, id, promo });
});

// Update specific totem's config
app.post("/api/totem/:id/config", (req, res) => {
  const { id } = req.params;
  const { video, audio } = req.body;
  
  if (!video || !audio) return res.status(400).json({ error: "Escolha um vídeo e um áudio" });
  
  // Persist
  if (!totemsConf[id]) totemsConf[id] = {};
  totemsConf[id].video = video;
  totemsConf[id].audio = audio;
  saveTotemsConf(totemsConf);
  
  console.log(`[Admin] Assigned video ${video} and audio ${audio} to totem ${id}`);
  
  // Every open screen of this campaign switches video right away
  sendToCampaign(id, videoMessage(id));
  
  res.json({ success: true, id, video, audio });
});

// ── Totems CRUD ─────────────────────────────────────────────────────────────
// IDs go into URLs (?screen=ID) and the admin markup, so keep them simple
const TOTEM_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

// Checks optional video/audio fields against assets/. Returns an error string or null.
function validateTotemMedia(video, audio) {
  if (video && !listMedia("video").includes(video)) return `Vídeo não encontrado: ${video}`;
  if (audio && !listMedia("audio").includes(audio)) return `Áudio não encontrado: ${audio}`;
  return null;
}

// Create: POST /api/totems  { id, video?, audio? }
app.post("/api/totems", (req, res) => {
  const { id, video = "", audio = "" } = req.body || {};
  if (!TOTEM_ID_RE.test(id || "")) {
    return res.status(400).json({ error: "O ID deve ter de 1 a 40 letras, números, - ou _" });
  }
  if (totemsConf[id]) return res.status(409).json({ error: `O totem "${id}" já existe` });
  const mediaError = validateTotemMedia(video, audio);
  if (mediaError) return res.status(400).json({ error: mediaError });

  totemsConf[id] = { video, audio };
  saveTotemsConf(totemsConf);
  console.log(`[Admin] Created totem ${id}`);

  // Screens already open under this ID pick up the video right away
  if (video) sendToCampaign(id, videoMessage(id));

  res.status(201).json({ success: true, id, video, audio });
});

// Update: PATCH /api/totem/:id  { id?, video?, audio? }  — `id` renames the totem
app.patch("/api/totem/:id", (req, res) => {
  const oldId = req.params.id;
  if (!totemsConf[oldId]) return res.status(404).json({ error: "Totem não encontrado" });

  const body = req.body || {};
  const newId = body.id === undefined ? oldId : String(body.id).trim();
  if (!TOTEM_ID_RE.test(newId)) {
    return res.status(400).json({ error: "O ID deve ter de 1 a 40 letras, números, - ou _" });
  }
  if (newId !== oldId && totemsConf[newId]) {
    return res.status(409).json({ error: `O totem "${newId}" já existe` });
  }

  const conf = { ...totemsConf[oldId] };
  if (body.video !== undefined) conf.video = body.video || "";
  if (body.audio !== undefined) conf.audio = body.audio || "";
  const mediaError = validateTotemMedia(body.video, body.audio);
  if (mediaError) return res.status(400).json({ error: mediaError });

  const mediaChanged = conf.video !== totemsConf[oldId].video || conf.audio !== totemsConf[oldId].audio;
  if (newId !== oldId) delete totemsConf[oldId];
  totemsConf[newId] = conf;
  saveTotemsConf(totemsConf);

  if (newId !== oldId) {
    // Every open screen reloads itself with ?screen=<newId>
    sendToCampaign(oldId, { type: "change_screen", screen: newId });
  } else if (mediaChanged && conf.video) {
    sendToCampaign(oldId, videoMessage(oldId));
  }

  console.log(`[Admin] Updated totem ${oldId}${newId !== oldId ? ` → ${newId}` : ""}`);
  res.json({ success: true, id: newId, renamed_from: newId !== oldId ? oldId : undefined, ...conf });
});

// Delete: DELETE /api/totem/:id  — removes the saved config (video, audio, links)
app.delete("/api/totem/:id", (req, res) => {
  const { id } = req.params;
  if (!totemsConf[id]) return res.status(404).json({ error: "Totem não encontrado" });

  delete totemsConf[id];
  saveTotemsConf(totemsConf);
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

  const filePath = path.join(ASSETS_DIR, filename);

  if (!fs.existsSync(filePath)) {
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
  else if (route === "mobile") handleMobile(ws, campaign, instanceId);
  else if (route === "drift") handleDrift(ws, campaign, instanceId);
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

  ws.on("message", (raw) => {
    try {
      const data = JSON.parse(raw);

      if (data.type === "position_update") {
        // Periodic position: recalculate start_time with the SERVER clock
        instances.updatePosition(inst, data.current_time);
        return;
      }

      // Registration: the screen sends its video.currentTime
      const session = instances.startSession(inst, data);
      console.log(`[Screen] Session ${campaign}/${inst.id} — ${session.duration}s (pos: ${(Number(data.current_time) || 0).toFixed(2)}s)`);
      safeSend(ws, { type: "session_created", screen_id: campaign, instance: inst.id });

      // Tell the screen which video to play
      if (totemsConf[campaign] && totemsConf[campaign].video) {
        safeSend(ws, videoMessage(campaign));
      }
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

// ── /ws/mobile/:campaign?instance=ID — phone sync (fire-and-close) ──────────
function handleMobile(ws, campaign, instanceId) {
  const inst = instances.resolve(campaign, instanceId);
  if (!inst) {
    safeSend(ws, { type: "error", detail: "Session not found" });
    ws.close(4004, "Session not found");
    return;
  }

  const conf = totemsConf[campaign];
  const audio = conf && conf.audio ? `/media/${conf.audio}` : "/media/ivete_audio.mp3"; // fallback

  // Send sync payload — NEVER send current_position
  safeSend(ws, {
    type: "sync",
    instance: inst.id,               // phone uses it for the drift socket
    start_time: inst.session.start_time,
    duration: inst.session.duration,
    server_time: Date.now() / 1000,
    drift_enabled: inst.session.drift_enabled,
    audio,
    promo: promoFor(campaign),
  });

  // Only the scanned screen hides its QR
  if (inst.ws) safeSend(inst.ws, { type: "mobile_connected" });

  ws.close(1000, "Sync delivered");
  ws.on("error", () => {});
}

// ── /ws/drift/:campaign?instance=ID — drift correction for one phone ───────
function handleDrift(ws, campaign, instanceId) {
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

  const cleanup = () => {
    clearInterval(interval);
    inst.drifts.delete(ws);
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
server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n  🎬 OOH Audio Sync running on http://0.0.0.0:${PORT}`);
  console.log(`  📺 Totem:  ${PUBLIC_URL}/static/totem.html?screen=totem1`);
  console.log(`  ⚙️  Admin:  ${PUBLIC_URL}/admin`);
  console.log(`  📱 Mobile: ${PUBLIC_URL}/static/mobile.html?screen=totem1`);
  console.log(`  📱 Mobile: ${PUBLIC_URL}/static/mobile_debug.html?screen=totem1`);
  console.log(`  ❤️  Health: ${PUBLIC_URL}/health`);
  console.log(`  📖 Docs:   ${PUBLIC_URL}/api-docs\n`);
  if (!ADMIN_USER || !ADMIN_PASSWORD) {
    console.warn("  ⚠️  ADMIN_USER / ADMIN_PASSWORD not set in .env — admin login is disabled\n");
  }
  if (!process.env.SESSION_SECRET) {
    console.warn("  ⚠️  SESSION_SECRET not set in .env — admin sessions end when the server restarts\n");
  }
});
