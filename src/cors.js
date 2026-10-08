const { CORS_ORIGINS } = require("./settings");

// CORS — off by default. Pages, iframes and phones all talk to this same
// origin, so nothing needs it. CORS_ORIGINS (comma-separated, or "*") opens
// only the read-only public routes; the admin API is never exposed.
const CORS_PUBLIC_PATHS = [/^\/media\//, /^\/health$/];

function cors(req, res, next) {
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
}

module.exports = { cors };
