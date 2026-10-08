/**
 * Error alerts with Sentry (optional): on only when SENTRY_DSN is set. Gets
 * every log.error(), Express route errors and crashes (uncaught exceptions,
 * unhandled promise rejections). No personal data is sent (sendDefaultPii off).
 */
const { log } = require("./log");

let Sentry = null;

function initSentry({ release } = {}) {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return false;
  Sentry = require("@sentry/node"); // loaded only when used
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.S3_PREFIX || "production",
    release,
    sendDefaultPii: false,
    tracesSampleRate: 0,
  });
  log.addReporter((err, context) => {
    Sentry.withScope(scope => {
      scope.setTag("scope", context.scope);
      scope.setExtra("message", context.msg);
      Sentry.captureException(err);
    });
  });
  return true;
}

// Express: route errors that reached the end of the chain
function sentryErrorHandler(app) {
  if (Sentry) Sentry.setupExpressErrorHandler(app);
}

// Crashes: log (→ Sentry), give Sentry 2s to send, then exit so pm2/systemd restart us
function handleCrashes() {
  const crash = kind => err => {
    log.error("Crash", `${kind}:`, err instanceof Error ? err : new Error(String(err)));
    const done = () => process.exit(1);
    if (Sentry) Sentry.flush(2000).then(done, done);
    else done();
  };
  process.on("uncaughtException", crash("uncaught exception"));
  process.on("unhandledRejection", crash("unhandled rejection"));
}

const flushSentry = (ms = 2000) => (Sentry ? Sentry.flush(ms) : Promise.resolve());

module.exports = { initSentry, sentryErrorHandler, handleCrashes, flushSentry };
