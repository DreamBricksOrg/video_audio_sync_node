/**
 * Settings from the environment (.env loaded here, once). Real environment
 * variables take precedence; ENV_FILE points elsewhere (tests use an empty
 * file so they never touch the real config).
 */
const crypto = require("crypto");
const path = require("path");
const { defaultS3BaseUrl } = require("../lib/media-url");

const ROOT = path.join(__dirname, "..");

try {
  process.loadEnvFile(process.env.ENV_FILE || path.join(ROOT, ".env"));
} catch (_) {}

const env = process.env;
const int = (value, fallback) => parseInt(value, 10) || fallback;

const PORT = env.PORT || 8001;

// S3 bucket for the media library (S3_BUCKET set = S3-only, no local copies)
const S3_CONFIG = {
  bucket: env.S3_BUCKET,
  region: env.S3_REGION,
  prefix: env.S3_PREFIX,
  endpoint: env.S3_ENDPOINT,
};

const VIDEO_EXTS = [".mp4", ".webm"];
const AUDIO_EXTS = [".mp3", ".wav", ".ogg"];

module.exports = {
  ROOT,
  PORT,
  PUBLIC_URL: (env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, ""),
  STATIC_DIR: path.join(ROOT, "static"),
  ASSETS_DIR: env.ASSETS_DIR || path.join(ROOT, "assets"),
  // TOTEMS_FILE lets tests (and deployments) keep the config elsewhere
  TOTEMS_FILE: env.TOTEMS_FILE || path.join(ROOT, "totems.json"),
  CONFIG_REFRESH_MS: int(env.CONFIG_REFRESH_MS, 15000),

  S3_CONFIG,
  // Where visitors download videos/audios: MEDIA_BASE_URL (bucket or CloudFront),
  // the bucket URL by default in S3 mode, or this server's /media route
  MEDIA_BASE_URL: env.MEDIA_BASE_URL || (S3_CONFIG.bucket ? defaultS3BaseUrl(S3_CONFIG) : ""),

  MAX_UPLOAD_BYTES: int(env.MAX_UPLOAD_MB, 500) * 1024 * 1024,
  VIDEO_EXTS,
  AUDIO_EXTS,
  MEDIA_EXTS: [...VIDEO_EXTS, ...AUDIO_EXTS],
  MIME_TYPES: {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
  },

  // Sync
  DRIFT_THRESHOLD_MS: 80,
  DRIFT_INTERVAL_MS: 2000,
  MAX_MOBILE_PER_SCREEN: 50,
  // Abuse protection for public embeds
  MAX_SCREENS_PER_IP: int(env.MAX_SCREENS_PER_IP, 20),
  MAX_INSTANCES_PER_CAMPAIGN: int(env.MAX_INSTANCES_PER_CAMPAIGN, 2000),
  // Phones: many share one IP (venue Wi-Fi, carrier NAT), so these are generous
  MAX_PHONES_PER_IP: int(env.MAX_PHONES_PER_IP, 50), // listening at once
  MAX_SYNCS_PER_IP_PER_MINUTE: int(env.MAX_SYNCS_PER_IP_PER_MINUTE, 120),
  // Behind a proxy/tunnel (ngrok, Nginx, Cloudflare) set TRUST_PROXY=1 to use X-Forwarded-For
  TRUST_PROXY: env.TRUST_PROXY === "1",
  // CORS: off by default; comma-separated origins (or "*") for /media and /health
  CORS_ORIGINS: (env.CORS_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean),

  // Admin auth — credentials come from .env
  ADMIN_USER: env.ADMIN_USER || "",
  ADMIN_PASSWORD: env.ADMIN_PASSWORD || "",
  // Without a fixed secret, logins are invalidated on every restart
  SESSION_SECRET: env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
  SESSION_SECRET_SET: !!env.SESSION_SECRET,
  SESSION_COOKIE: "db_admin",
  LOGIN_MAX_FAILURES: 5,
  LOGIN_LOCK_MS: 60 * 1000,
};
