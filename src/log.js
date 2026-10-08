/**
 * Logs. LOG_FORMAT=text (default) prints the familiar "[Scope] message" lines;
 * LOG_FORMAT=json prints one JSON object per line (time, level, scope, msg,
 * error) for log tools (CloudWatch, Loki, `pm2 logs --json`…).
 *
 * log.error() also reports to Sentry when SENTRY_DSN is set (src/sentry.js).
 * Extra arguments after the message are appended: strings as-is, Errors by
 * their message (the stack goes into the JSON "error" field).
 */
function createLogger({
  format = process.env.LOG_FORMAT === "json" ? "json" : "text",
  now = () => new Date(),
  write = (level, line) => (level === "info" ? console.log : level === "warn" ? console.warn : console.error)(line),
  report = () => {},
} = {}) {
  function emit(level, scope, message, extras) {
    const error = extras.find(x => x instanceof Error);
    const text = [message, ...extras.map(x => (x instanceof Error ? x.message : typeof x === "string" ? x : JSON.stringify(x)))]
      .filter(s => s !== "" && s !== undefined)
      .join(" ");
    if (format === "json") {
      const entry = { time: now().toISOString(), level, scope, msg: text };
      if (error) entry.error = { message: error.message, stack: error.stack, ...(error.code ? { code: error.code } : {}) };
      write(level, JSON.stringify(entry));
    } else {
      write(level, `[${scope}] ${text}`);
    }
    if (level === "error") {
      try {
        report(error || new Error(`[${scope}] ${text}`), { scope, msg: text });
      } catch (_) {}
    }
  }

  return {
    info: (scope, message, ...extras) => emit("info", scope, message, extras),
    warn: (scope, message, ...extras) => emit("warn", scope, message, extras),
    error: (scope, message, ...extras) => emit("error", scope, message, extras),
    format,
  };
}

// The app's logger; src/sentry.js plugs its reporter in at startup
const reporters = [];
const log = createLogger({ report: (err, context) => reporters.forEach(r => r(err, context)) });
log.addReporter = fn => reporters.push(fn);

module.exports = { createLogger, log };
