/**
 * Admin login: sessions in sessions.json (next to totems.json, or in the bucket
 * in S3 mode), the login/logout routes and the requireAuth / requireAdmin
 * middlewares. Who can log in: src/users.js.
 */
const crypto = require("crypto");
const path = require("path");
const {
  ADMIN_USER, SESSION_COOKIE, LOGIN_MAX_FAILURES, LOGIN_LOCK_MS, TOTEMS_FILE, STATIC_DIR,
  SESSION_SECRET, DEFAULT_USER_PASSWORD, SIGNUP_EMAIL_DOMAIN,
} = require("./settings");
const { HttpError } = require("./http-error");
const { createFileConfigStore, createS3ConfigStore, isConfigConflict } = require("../lib/config-store");
const { createSyncedDoc } = require("../lib/synced-doc");
const { log } = require("./log");

function createAuth({ storage, users, audit }) {
  // The cookie holds a random session id. Sessions live in sessions.json (next to
  // totems.json, or in the bucket next to the config in S3 mode, so every server
  // shares them), keyed by a hash of the id: reading the file doesn't give
  // anyone a usable cookie. Logout deletes the session, so a copied cookie stops
  // working. Each session records its user and a tag of the user's password, so
  // a new password (or SESSION_SECRET) ends that user's sessions, and deleting
  // the user ends them all. The role is read live: changing it applies at once.
  const SESSIONS_NAME = "sessions.json";
  const MAX_SESSIONS = 100;
  const SESSION_ID_RE = /^[A-Za-z0-9_-]{43}$/;

  const sessionStore = storage.enabled
    ? createS3ConfigStore({ storage, name: SESSIONS_NAME })
    : createFileConfigStore({ file: process.env.SESSIONS_FILE || path.join(path.dirname(TOTEMS_FILE), SESSIONS_NAME) });
  const sessionsDoc = createSyncedDoc({ store: sessionStore, isConflict: isConfigConflict });

  const sessionKey = id => crypto.createHash("sha256").update(id).digest("base64url");

  // Only the first failure in a row is an error (→ Sentry); repeats are warnings
  let refreshError = null;
  async function refreshSessions() {
    try {
      await sessionsDoc.refresh();
      refreshError = null;
    } catch (e) {
      (refreshError ? log.warn : log.error)("Auth", "Sessions refresh failed:", e);
      refreshError = e.message || String(e);
    }
  }
  const status = () => (refreshError ? { ok: false, error: refreshError } : { ok: true });

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
          return Promise.all([refreshSessions(), users.refresh()]);
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

  // The user of a stored session, if it's still valid (user exists, same password)
  function sessionUser(s) {
    if (!s) return null;
    const user = users.find(s.user || ADMIN_USER); // sessions from before users = the .env account
    return user && safeEqual(s.auth, user.tag) ? user : null;
  }

  // { key, user } when the request carries a valid session, else null
  async function currentSession(req) {
    if (!users.any()) return null;
    const id = getCookie(req, SESSION_COOKIE);
    if (!id || !SESSION_ID_RE.test(id)) return null;
    const key = sessionKey(id);
    const valid = () => {
      const user = sessionUser(sessionsDoc.get()[key]);
      return user ? { key, user } : null;
    };
    const found = valid();
    if (found) return found;
    await refreshSessionsForUnknown();
    return valid();
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
    currentSession(req).then(session => {
      if (session) {
        req.sessionKey = session.key;
        req.user = { name: session.user.name, displayName: session.user.displayName, role: session.user.role, main: session.user.main };
        return next();
      }
      if (req.originalUrl.startsWith("/api/")) return res.status(401).json({ error: "Não autenticado" });
      res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    }, next);
  }

  // After requireAuth: only the Admin role (users, activity log, other sessions)
  function requireAdmin(req, res, next) {
    if (req.user && req.user.role === "admin") return next();
    res.status(403).json({ error: "Só administradores podem fazer isso" });
  }

  // Brute-force guard: lock an IP for a minute after repeated failures
  const loginFailures = new Map(); // ip → { count, lockedUntil }

  // Starts a session for `user`: saved in sessions.json, id in the cookie
  async function startSession(req, res, user) {
    const id = crypto.randomBytes(32).toString("base64url");
    await sessionsDoc.mutate(all => {
      all[sessionKey(id)] = { created: new Date().toISOString(), user: user.name, auth: user.tag };
      // Keep the newest MAX_SESSIONS (old forgotten browsers drop off)
      const keys = Object.keys(all).sort((a, b) => String(all[b].created).localeCompare(String(all[a].created)));
      keys.slice(MAX_SESSIONS).forEach(k => delete all[k]);
    });
    // ~10 years: the session only ends on logout
    setSessionCookie(req, res, id, 10 * 365 * 24 * 3600);
  }

  // ── Self sign-up ──
  // An e-mail of SIGNUP_EMAIL_DOMAIN that has no user yet + the invite password
  // (DEFAULT_USER_PASSWORD) gets a signed pass, valid 15 minutes, for the
  // "create your user" page. The pass only proves that step happened.
  const SIGNUP_TTL_MS = 15 * 60 * 1000;
  const signupOn = () => !!DEFAULT_USER_PASSWORD;
  const domainEmail = login => {
    const email = String(login || "").trim().toLowerCase();
    const at = email.lastIndexOf("@");
    return at > 0 && email.slice(at + 1) === SIGNUP_EMAIL_DOMAIN && /^[a-z0-9._%+-]+$/.test(email.slice(0, at)) ? email : null;
  };
  const signPass = payload => crypto.createHmac("sha256", SESSION_SECRET).update(`signup:${payload}`).digest("base64url");
  function signupPass(email) {
    const payload = Buffer.from(JSON.stringify({ email, exp: Date.now() + SIGNUP_TTL_MS })).toString("base64url");
    return `${payload}.${signPass(payload)}`;
  }
  function readSignupPass(pass) {
    const [payload, sig] = String(pass || "").split(".");
    if (!payload || !sig || !safeEqual(sig, signPass(payload))) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, "base64url").toString());
      return data.exp > Date.now() && domainEmail(data.email) ? data.email : null;
    } catch (_) {
      return null;
    }
  }

  // Login/logout and the admin pages; everything registered after this on
  // /api and /api-docs requires a session
  function register(app) {
    app.get("/login", async (req, res) => {
      if (await currentSession(req)) return res.redirect("/admin");
      res.sendFile(path.join(STATIC_DIR, "login.html"));
    });

    app.post("/api/login", async (req, res) => {
      if (!users.any() && !signupOn()) {
        return res.status(503).json({ error: "Login não configurado (defina ADMIN_USER e ADMIN_PASSWORD no .env)" });
      }

      const ip = req.ip;
      const entry = loginFailures.get(ip);
      if (entry && entry.lockedUntil > Date.now()) {
        const wait = Math.ceil((entry.lockedUntil - Date.now()) / 1000);
        return res.status(429).json({ error: `Muitas tentativas. Tente de novo em ${wait}s.` });
      }

      const { username, password } = req.body || {};
      const user = await users.verify(String(username || ""), String(password || ""));

      // First time of an @domain e-mail with the invite password → "create your user"
      const email = !user && signupOn() && domainEmail(username);
      if (email && safeEqual(password || "", DEFAULT_USER_PASSWORD) && !(await users.exists(email))) {
        log.info("Auth", `Sign-up started for ${email} from ${ip}`);
        return res.json({ signup: true, email, token: signupPass(email) });
      }

      if (!user) {
        // An expired lock starts a fresh count
        const count = entry && !entry.lockedUntil ? entry.count + 1 : 1;
        loginFailures.set(ip, { count, lockedUntil: count >= LOGIN_MAX_FAILURES ? Date.now() + LOGIN_LOCK_MS : 0 });
        log.warn("Auth", `Failed login from ${ip} (${count})`);
        return res.status(401).json({ error: "Usuário ou senha inválidos" });
      }

      loginFailures.delete(ip);
      try {
        await startSession(req, res, user);
      } catch (err) {
        log.error("Auth", "Could not save the session:", err);
        return res.status(502).json({ error: "Não foi possível iniciar a sessão. Tente de novo." });
      }
      log.info("Auth", `${user.name} logged in from ${ip}`);
      audit.record(user.name, "Entrou");
      res.json({ success: true, user: user.name, role: user.role });
    });

    // "Create your user" page and its form (public: the signed pass is the check)
    app.get("/signup", (req, res) => {
      if (!signupOn()) return res.redirect("/login");
      res.sendFile(path.join(STATIC_DIR, "signup.html"));
    });

    app.post("/api/signup", async (req, res) => {
      if (!signupOn()) return res.status(404).json({ error: "Cadastro desligado" });
      const { token, name, password } = req.body || {};
      const email = readSignupPass(token);
      if (!email) {
        return res.status(400).json({ error: "O link de cadastro expirou ou é inválido. Entre de novo com seu e-mail e a senha de convite." });
      }
      let user;
      try {
        user = await users.createSelf({ email, displayName: name, password });
        await startSession(req, res, user);
      } catch (err) {
        if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
        log.error("Auth", "Sign-up failed:", err);
        return res.status(502).json({ error: "Não foi possível criar o usuário. Tente de novo." });
      }
      log.info("Auth", `${email} created their user and logged in`);
      audit.record(email, "Criou a própria conta");
      res.status(201).json({ success: true, user: email, name: user.displayName, role: user.role });
    });

    app.post("/api/logout", async (req, res) => {
      setSessionCookie(req, res, "", 0);
      const session = await currentSession(req);
      try {
        if (session) {
          await sessionsDoc.mutate(all => { delete all[session.key]; });
          audit.record(session.user.name, "Saiu");
        }
      } catch (err) {
        log.error("Auth", "Could not end the session:", err);
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

    app.get("/api/session", (req, res) => res.json({
      user: req.user.name, name: req.user.displayName || req.user.name, role: req.user.role, main: req.user.main,
    }));

    // How many browsers are logged in (all users)
    app.get("/api/sessions", (req, res) => {
      res.json({ count: Object.values(sessionsDoc.get()).filter(s => sessionUser(s)).length });
    });

    // "Desconectar outros aparelhos" (admins): end every session except this one
    app.post("/api/sessions/revoke-others", requireAdmin, async (req, res) => {
      try {
        const revoked = await sessionsDoc.mutate(all => {
          const others = Object.keys(all).filter(k => k !== req.sessionKey);
          others.forEach(k => delete all[k]);
          return others.length;
        });
        log.info("Auth", `${revoked} other session(s) ended`);
        res.json({ success: true, revoked });
      } catch (err) {
        log.error("Auth", "Could not end the sessions:", err);
        res.status(502).json({ error: "Não foi possível desconectar os outros aparelhos. Tente de novo." });
      }
    });
  }

  return { register, requireAuth, requireAdmin, currentSession, refreshSessions, status, load: () => sessionsDoc.load() };
}

module.exports = { createAuth };
