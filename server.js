/**
 * OOH Audio Sync — server entry point.
 *
 * A totem page plays a campaign's videos; phones that scan its QR play the
 * matching audio in sync. This file only wires the pieces together, in the
 * order the routes must be registered:
 *
 *   src/settings.js         .env and every setting
 *   src/campaigns.js        shared campaigns config, what is on air, broadcasts to screens
 *   src/auth.js             admin login and sessions
 *   src/stats-service.js    daily statistics
 *   src/media-library.js    media library helpers (S3 bucket or assets/)
 *   src/routes/*.js         HTTP routes (public, media, campaigns)
 *   src/realtime.js         WebSockets: screens, phone sync, drift correction
 *   lib/                    pure building blocks (stores, timeline, stats…)
 */
const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const bodyParser = require("body-parser");
const swaggerUi = require("swagger-ui-express");
const YAML = require("yaml");

const settings = require("./src/settings");
const { createInstanceRegistry } = require("./lib/instances");
const { createMediaUrl } = require("./lib/media-url");
const { createS3Storage } = require("./lib/s3-storage");
const { createLocalStore, createS3Store } = require("./lib/media-store");
const { createCampaigns } = require("./src/campaigns");
const { createAuth } = require("./src/auth");
const { createStatsService } = require("./src/stats-service");
const { createMediaLibrary } = require("./src/media-library");
const { cors } = require("./src/cors");
const { registerPublicRoutes, registerQrPage } = require("./src/routes/public");
const { registerMediaRoutes } = require("./src/routes/media");
const { registerCampaignRoutes } = require("./src/routes/campaigns");
const { attachRealtime } = require("./src/realtime");
const { log } = require("./src/log");
const { initSentry, sentryErrorHandler, handleCrashes, flushSentry } = require("./src/sentry");

// Version shown in /health and sent to Sentry: package version + git commit
const VERSION = (() => {
  const pkg = require("./package.json").version;
  try {
    const commit = require("child_process")
      .execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: __dirname, stdio: ["ignore", "pipe", "ignore"] })
      .toString().trim();
    return commit ? `${pkg}+${commit}` : pkg;
  } catch (_) {
    return pkg;
  }
})();

// Error alerts (only with SENTRY_DSN) and crash reporting
const sentryOn = initSentry({ release: VERSION });
handleCrashes();

const { PORT, PUBLIC_URL, MEDIA_BASE_URL, S3_CONFIG, ASSETS_DIR, MEDIA_EXTS, MIME_TYPES, CONFIG_REFRESH_MS } = settings;

// ── Storage ─────────────────────────────────────────────────────────────────
// Media library: the S3 bucket when S3_BUCKET is set (S3-only), otherwise assets/
const storage = createS3Storage({
  ...S3_CONFIG,
  contentTypeFor: f => MIME_TYPES[path.extname(f).toLowerCase()] || "application/octet-stream",
});
const mediaStore = storage.enabled
  ? createS3Store({ storage, exts: MEDIA_EXTS })
  : createLocalStore({ dir: ASSETS_DIR, exts: MEDIA_EXTS });
const mediaUrl = createMediaUrl(MEDIA_BASE_URL);

// ── Services ────────────────────────────────────────────────────────────────
// Every screen playing a campaign (totem or iframe) is an instance with its own session
const instances = createInstanceRegistry();
// Forget screens that closed more than 2 minutes ago (and have no phones listening)
setInterval(() => instances.sweep(), 30000).unref();

const campaigns = createCampaigns({ storage, instances, mediaUrl });
const auth = createAuth({ storage });
const statsService = createStatsService({ storage, campaigns });
const library = createMediaLibrary({ mediaStore, campaigns });

// ── HTTP ────────────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

app.use(cors);
app.use(bodyParser.json());

registerQrPage(app);
auth.register(app); // from here on, /api and /api-docs need the admin login
statsService.register(app, { storageErrorMessage: library.storageErrorMessage });

const swaggerDocument = YAML.parse(fs.readFileSync(path.join(__dirname, "openapi.yaml"), "utf8"));
swaggerDocument.servers = [{ url: PUBLIC_URL }];
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));

registerMediaRoutes(app, { storage, mediaStore, library, campaigns });
registerCampaignRoutes(app, { instances, mediaStore, library, campaigns });
registerPublicRoutes(app, {
  instances, mediaStore, mediaUrl, version: VERSION,
  checks: { media: () => mediaStore.status(), config: campaigns.status, sessions: auth.status },
});
sentryErrorHandler(app);

// ── WebSockets ──────────────────────────────────────────────────────────────
attachRealtime(server, { instances, campaigns, stats: statsService.stats, mediaUrl });

// ── Start server ────────────────────────────────────────────────────────────
// Load the media library first (the bucket listing in S3 mode), then listen.
// Never start with an empty config by mistake: retry a few times, then give up.
async function loadWithRetry(load, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      return await load();
    } catch (err) {
      if (i >= attempts) throw err;
      log.warn("Config", `Load failed (${err.message}) — retrying (${i}/${attempts - 1})`);
      await new Promise(r => setTimeout(r, 1000 * i));
    }
  }
}

// Startup banner: as is in text mode; in JSON mode each line is a log entry
function say(level, line) {
  if (log.format === "json") log[level]("Server", line.trim().replace(/^\S+\s+/, ""));
  else (level === "warn" ? console.warn : console.log)(line);
}

Promise.all([
  mediaStore.init(),
  loadWithRetry(campaigns.load),
  loadWithRetry(auth.load),
]).catch(err => {
  log.error("Server", `Could not load the campaigns config / admin sessions (${campaigns.configStore.describe()}):`, err);
  flushSentry().finally(() => process.exit(1));
}).then(() => server.listen(PORT, "0.0.0.0", () => {
  say("info", `\n  🎬 OOH Audio Sync running on http://0.0.0.0:${PORT}`);
  say("info", `  📺 Totem:  ${PUBLIC_URL}/static/totem.html?screen=totem1`);
  say("info", `  ⚙️  Admin:  ${PUBLIC_URL}/admin`);
  say("info", `  📱 Mobile: ${PUBLIC_URL}/static/mobile.html?screen=totem1`);
  say("info", `  🔧 Debug:  ${PUBLIC_URL}/static/mobile_debug.html?screen=totem1 (admin login)`);
  say("info", `  ❤️  Health: ${PUBLIC_URL}/health`);
  say("info", `  📖 Docs:   ${PUBLIC_URL}/api-docs\n`);
  const status = mediaStore.status();
  if (mediaStore.remote) {
    say("info", `  ☁️  Media library: ${mediaStore.describe()} (${mediaStore.list().length} files) — served from ${MEDIA_BASE_URL}\n`);
    if (!status.ok) log.error("Media", `Could not list the S3 bucket: ${status.error}`);
    // Pick up changes made outside the admin (console, s3-sync, another server)
    setInterval(() => mediaStore.refresh(), 60000).unref();
    say("info", `  🗂️  Campaigns config: ${campaigns.configStore.describe()} (${Object.keys(campaigns.conf).length} campaigns, shared by every server on this bucket/prefix)\n`);
    setInterval(campaigns.refreshConfig, CONFIG_REFRESH_MS).unref();
    setInterval(auth.refreshSessions, CONFIG_REFRESH_MS).unref();
  } else {
    say("info", `  📁 Media library: ${mediaStore.describe()} (${mediaStore.list().length} files)\n`);
  }
  if (!settings.ADMIN_USER || !settings.ADMIN_PASSWORD) {
    say("warn", "  ⚠️  ADMIN_USER / ADMIN_PASSWORD not set in .env — admin login is disabled\n");
  }
  if (sentryOn) say("info", "  🚨 Error alerts: Sentry on (SENTRY_DSN)\n");
  if (!settings.SESSION_SECRET_SET) {
    say("warn", "  ⚠️  SESSION_SECRET not set in .env — admin sessions end when the server restarts\n");
  }
}));

// Restart/deploy (pm2, systemd, Ctrl+C): save the last minute of statistics first
let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (shuttingDown) process.exit(0);
    shuttingDown = true;
    const timeout = setTimeout(() => process.exit(0), 5000);
    statsService.flushStats().then(() => flushSentry()).finally(() => {
      clearTimeout(timeout);
      process.exit(0);
    });
  });
}
