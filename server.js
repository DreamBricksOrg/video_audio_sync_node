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
registerPublicRoutes(app, { instances, mediaStore, mediaUrl });

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
      console.warn(`[Config] Load failed (${err.message}) — retrying (${i}/${attempts - 1})`);
      await new Promise(r => setTimeout(r, 1000 * i));
    }
  }
}

Promise.all([
  mediaStore.init(),
  loadWithRetry(campaigns.load),
  loadWithRetry(auth.load),
]).catch(err => {
  console.error(`\n  ❌ Could not load the campaigns config / admin sessions (${campaigns.configStore.describe()}): ${err.message}\n`);
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
    console.log(`  🗂️  Campaigns config: ${campaigns.configStore.describe()} (${Object.keys(campaigns.conf).length} campaigns, shared by every server on this bucket/prefix)\n`);
    setInterval(campaigns.refreshConfig, CONFIG_REFRESH_MS).unref();
    setInterval(auth.refreshSessions, CONFIG_REFRESH_MS).unref();
  } else {
    console.log(`  📁 Media library: ${mediaStore.describe()} (${mediaStore.list().length} files)\n`);
  }
  if (!settings.ADMIN_USER || !settings.ADMIN_PASSWORD) {
    console.warn("  ⚠️  ADMIN_USER / ADMIN_PASSWORD not set in .env — admin login is disabled\n");
  }
  if (!settings.SESSION_SECRET_SET) {
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
    statsService.flushStats().finally(() => {
      clearTimeout(timeout);
      process.exit(0);
    });
  });
}
