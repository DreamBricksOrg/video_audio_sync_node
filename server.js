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
const url = require("url");

// ── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8001;
const DRIFT_THRESHOLD_MS = 80;
const DRIFT_INTERVAL_MS = 2000;
const MAX_MOBILE_PER_SCREEN = 50;
const ASSETS_DIR = path.join(__dirname, "assets");
const STATIC_DIR = path.join(__dirname, "static");

const MIME_TYPES = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
};

// ── In-memory stores ────────────────────────────────────────────────────────
const sessions = {};
const screenClients = {};   // { screenId: ws } — one totem per screen
const mobileClients = {};   // { screenId: Set<ws> }
const driftClients = {};    // { screenId: Set<ws> }

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
  next();
});

// ── Health check ────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  const mobileCount = Object.values(mobileClients).reduce((sum, s) => sum + s.size, 0);
  const driftCount = Object.values(driftClients).reduce((sum, s) => sum + s.size, 0);
  res.json({
    status: "ok",
    server_time: Date.now() / 1000,
    sessions: Object.keys(sessions).length,
    mobile_clients: mobileCount,
    drift_clients: driftCount,
    uptime_s: Math.round(process.uptime()),
  });
});

// ── Media streaming with Range support ──────────────────────────────────────
app.get("/media/:filename", (req, res) => {
  const filename = req.params.filename;

  if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    return res.status(400).json({ error: "Invalid filename" });
  }

  const filePath = path.join(ASSETS_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const ext = path.extname(filename).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  const range = req.headers.range;

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
      "Cache-Control": "public, max-age=86400",
    });

    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      "Content-Length": fileSize,
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=86400",
    });

    fs.createReadStream(filePath).pipe(res);
  }
});

// ── Static files ────────────────────────────────────────────────────────────
app.use("/static", express.static(STATIC_DIR));

// ── WebSocket server ────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

// ── WS route matching ───────────────────────────────────────────────────────
server.on("upgrade", (req, socket, head) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  let match;

  match = pathname.match(/^\/ws\/screen\/([^/]+)$/);
  if (match) {
    req._wsRoute = "screen";
    req._screenId = match[1];
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    return;
  }

  match = pathname.match(/^\/ws\/mobile\/([^/]+)$/);
  if (match) {
    req._wsRoute = "mobile";
    req._screenId = match[1];
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    return;
  }

  match = pathname.match(/^\/ws\/drift\/([^/]+)$/);
  if (match) {
    req._wsRoute = "drift";
    req._screenId = match[1];
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    return;
  }

  socket.destroy();
});

// ── WS connection handler ───────────────────────────────────────────────────
wss.on("connection", (ws, req) => {
  const route = req._wsRoute;
  const screenId = req._screenId;

  if (route === "screen") handleScreen(ws, screenId);
  else if (route === "mobile") handleMobile(ws, screenId);
  else if (route === "drift") handleDrift(ws, screenId);
});

// ── /ws/screen/:screenId — Totem registration (stays open for notifications) ─
function handleScreen(ws, screenId) {
  console.log(`[Screen] ${screenId} connected`);

  // Track this screen's WS so we can push events to the totem
  screenClients[screenId] = ws;

  ws.on("message", (raw) => {
    try {
      const data = JSON.parse(raw);

      if (data.type === "position_update") {
        // Periodic position update from totem — recalculate start_time
        // using SERVER clock so all time references stay in the same domain
        const session = sessions[screenId];
        if (session) {
          const serverNow = Date.now() / 1000;
          session.start_time = serverNow - data.current_time;
          console.log(`[Screen] ${screenId} position update: ${data.current_time.toFixed(2)}s → start_time recalc`);
        }
        return;
      }

      // Initial registration: totem sends current_time (video.currentTime),
      // server computes start_time using its OWN clock
      const serverNow = Date.now() / 1000;
      const currentTime = data.current_time || 0;

      sessions[screenId] = {
        start_time: serverNow - currentTime,
        duration: data.duration,
        mode: data.mode || "sync",
        drift_enabled: data.drift_enabled || false,
        created_at: serverNow,
      };

      console.log(`[Screen] Session: ${screenId} — ${sessions[screenId].duration}s (pos: ${currentTime.toFixed(2)}s)`);
      safeSend(ws, { type: "session_created", screen_id: screenId });
      // WS stays open to receive notifications (e.g. mobile_connected)
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
    if (screenClients[screenId] === ws) delete screenClients[screenId];
    console.log(`[Screen] ${screenId} disconnected`);
  });
}

// ── /ws/mobile/:screenId — Mobile sync (fire-and-close) ─────────────────────
function handleMobile(ws, screenId) {
  // Track client
  if (!mobileClients[screenId]) mobileClients[screenId] = new Set();

  // Enforce max connections
  if (mobileClients[screenId].size >= MAX_MOBILE_PER_SCREEN) {
    safeSend(ws, { type: "error", detail: "Too many connections" });
    ws.close(4029, "Too many connections");
    return;
  }

  mobileClients[screenId].add(ws);

  const session = sessions[screenId];

  if (!session) {
    safeSend(ws, { type: "error", detail: "Session not found" });
    ws.close(4004, "Session not found");
    mobileClients[screenId].delete(ws);
    return;
  }

  // Send sync payload — NEVER send current_position
  safeSend(ws, {
    type: "sync",
    start_time: session.start_time,
    duration: session.duration,
    server_time: Date.now() / 1000,
    drift_enabled: session.drift_enabled,
  });

  // Notify the totem that a mobile connected
  const screenWs = screenClients[screenId];
  if (screenWs && screenWs.readyState === 1) {
    safeSend(screenWs, { type: "mobile_connected" });
  }

  // Close immediately after sending — no need to keep open
  ws.close(1000, "Sync delivered");

  const cleanup = () => {
    if (mobileClients[screenId]) {
      mobileClients[screenId].delete(ws);
      if (mobileClients[screenId].size === 0) delete mobileClients[screenId];
    }
  };

  ws.on("error", cleanup);
  ws.on("close", cleanup);
}

// ── /ws/drift/:screenId — Drift correction ──────────────────────────────────
function handleDrift(ws, screenId) {
  // Track client
  if (!driftClients[screenId]) driftClients[screenId] = new Set();

  // Enforce max
  if (driftClients[screenId].size >= MAX_MOBILE_PER_SCREEN) {
    safeSend(ws, { type: "error", detail: "Too many drift connections" });
    ws.close(4029, "Too many connections");
    return;
  }

  driftClients[screenId].add(ws);

  // Drift check interval
  const interval = setInterval(() => {
    const session = sessions[screenId];
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
      if (data.type === "position_report") {
        const session = sessions[screenId];
        if (!session) return;

        const correction = computeCorrection(data.position, session.start_time, session.duration);
        safeSend(ws, correction || { type: "drift_ok" });
      }
    } catch (_) {}
  });

  const cleanup = () => {
    clearInterval(interval);
    if (driftClients[screenId]) {
      driftClients[screenId].delete(ws);
      if (driftClients[screenId].size === 0) delete driftClients[screenId];
    }
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
  console.log(`  📺 Totem:  http://dbaudiosync.ngrok.app/static/totem.html`);
  console.log(`  📱 Mobile: http://dbaudiosync.ngrok.app/static/mobile.html?screen=totem1`);
  console.log(`  📱 Mobile: http://dbaudiosync.ngrok.app/static/mobile_debug.html?screen=totem1`);
  console.log(`  ❤️  Health: http://dbaudiosync.ngrok.app/health\n`);
});
