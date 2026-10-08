/**
 * Admin login: sessions in sessions.json (next to totems.json, or in the bucket
 * in S3 mode), the login/logout routes and the requireAuth middleware.
 */
const crypto = require("crypto");
const path = require("path");
const {
  ADMIN_USER, ADMIN_PASSWORD, SESSION_SECRET, SESSION_COOKIE, LOGIN_MAX_FAILURES, LOGIN_LOCK_MS,
  TOTEMS_FILE, STATIC_DIR,
} = require("./settings");
const { createFileConfigStore, createS3ConfigStore, isConfigConflict } = require("../lib/config-store");
const { createSyncedDoc } = require("../lib/synced-doc");

function createAuth({ storage }) {
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

  // Login/logout and the admin pages; everything registered after this on
  // /api and /api-docs requires a session
  function register(app) {
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
  }

  return { register, requireAuth, currentSession, refreshSessions, load: () => sessionsDoc.load() };
}

module.exports = { createAuth };
