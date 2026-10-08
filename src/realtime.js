/**
 * WebSockets: screens (/ws/screen), phone sync (/ws/mobile) and drift
 * correction (/ws/drift), with the per-IP / per-campaign limits.
 */
const url = require("url");
const { WebSocketServer } = require("ws");
const {
  DRIFT_THRESHOLD_MS, DRIFT_INTERVAL_MS, MAX_MOBILE_PER_SCREEN, MAX_SCREENS_PER_IP, MAX_INSTANCES_PER_CAMPAIGN,
  MAX_PHONES_PER_IP, MAX_SYNCS_PER_IP_PER_MINUTE, TRUST_PROXY,
} = require("./settings");
const { safeSend } = require("./safe-send");
const { log } = require("./log");

function attachRealtime(server, { instances, campaigns, stats, mediaUrl }) {
  const { contentFor, videoMessage, sentContentKeys, notifyPhones, promoFor } = campaigns;

  // ── WebSocket server ────────────────────────────────────────────────────────
  const wss = new WebSocketServer({ noServer: true });

  // ── WS route matching ───────────────────────────────────────────────────────
  const screensPerIp = new Map(); // ip → open screen sockets
  const phonesPerIp = new Map();  // ip → open drift sockets (phones listening)
  const syncsPerIp = new Map();   // ip → { count, windowStart } (sync attempts per minute)

  // Fixed one-minute window per IP; returns false when over the limit
  function allowSync(ip) {
    const now = Date.now();
    const entry = syncsPerIp.get(ip);
    if (!entry || now - entry.windowStart >= 60000) {
      syncsPerIp.set(ip, { count: 1, windowStart: now });
      return true;
    }
    entry.count++;
    return entry.count <= MAX_SYNCS_PER_IP_PER_MINUTE;
  }
  // Forget idle windows so the map doesn't grow forever
  setInterval(() => {
    const now = Date.now();
    for (const [ip, e] of syncsPerIp) if (now - e.windowStart >= 60000) syncsPerIp.delete(ip);
  }, 60000).unref();

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
    else if (route === "mobile") handleMobile(ws, campaign, instanceId, req._ip);
    else if (route === "drift") handleDrift(ws, campaign, instanceId, req._ip);
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
    log.info("Screen", `${campaign}/${inst.id} connected`);
    // A new screen counts once (reconnects of the same instance don't)
    let counted = reconnecting;

    ws.on("message", (raw) => {
      try {
        const data = JSON.parse(raw);

        if (data.type === "position_update") {
          // Periodic position: recalculate start_time with the SERVER clock
          instances.updatePosition(inst, data.current_time);
          return;
        }

        if (!counted) {
          counted = true;
          stats.screenOpened(campaign, data.site);
        }

        // Registration: the screen sends its position in the whole cycle
        // (current_time), the cycle length (duration) and, for playlists, the
        // length of each video (items). Sent again whenever it loads new content.
        const hadSession = !!inst.session;
        const session = instances.startSession(inst, data);
        session.items = itemDurations(data.items, session.duration);
        log.info("Screen", `Session ${campaign}/${inst.id} — ${session.duration}s` +
          `${session.items ? ` (${session.items.length} videos)` : ""} (pos: ${(Number(data.current_time) || 0).toFixed(2)}s)`);
        safeSend(ws, { type: "session_created", screen_id: campaign, instance: inst.id });
        // Phones already listening must follow the new timeline
        if (hadSession) notifyPhones(inst);

        // Tell the screen what to play
        const msg = videoMessage(campaign);
        sentContentKeys.set(campaign, msg.key);
        safeSend(ws, msg);
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
      log.info("Screen", `${campaign}/${inst.id} disconnected`);
    });
  }

  // Video lengths a screen reports for its playlist (≤ 20 positive numbers that
  // add up to the cycle); null when missing or inconsistent
  function itemDurations(raw, total) {
    if (!Array.isArray(raw) || !raw.length || raw.length > 20) return null;
    const list = raw.map(Number);
    if (!list.every(d => Number.isFinite(d) && d > 0)) return null;
    const sum = list.reduce((a, b) => a + b, 0);
    return Math.abs(sum - total) < 0.5 ? list : null;
  }

  // The phone's timeline: each item's audio with its start and length in the
  // cycle. Without lengths from the screen (older page, or it hasn't reloaded
  // the new playlist yet), the first audio spans the whole cycle.
  function phoneItems(playlist, session) {
    const durations = session.items && session.items.length === playlist.length ? session.items : null;
    if (!durations) return [{ audio: mediaUrl(playlist[0].audio), start: 0, duration: session.duration }];
    let start = 0;
    return playlist.map((item, i) => {
      const entry = { audio: mediaUrl(item.audio), start, duration: durations[i] };
      start += durations[i];
      return entry;
    });
  }

  // ── /ws/mobile/:campaign?instance=ID — phone sync (fire-and-close) ──────────
  function handleMobile(ws, campaign, instanceId, ip) {
    if ((TRUST_PROXY || !isLoopback(ip)) && !allowSync(ip)) {
      ws.close(4029, "Too many syncs from this address");
      return;
    }
    const inst = instances.resolve(campaign, instanceId);
    if (!inst) {
      safeSend(ws, { type: "error", detail: "Session not found" });
      ws.close(4004, "Session not found");
      return;
    }

    // Nothing on air (outside the period, no fallback): the phone waits
    const content = contentFor(campaign);
    if (!content) {
      safeSend(ws, { type: "idle" });
      ws.close(4010, "Nothing on air");
      return;
    }

    // Send sync payload — NEVER send current_position
    safeSend(ws, {
      type: "sync",
      instance: inst.id,               // phone uses it for the drift socket
      start_time: inst.session.start_time,
      duration: inst.session.duration, // whole cycle (all videos)
      server_time: Date.now() / 1000,
      drift_enabled: inst.session.drift_enabled,
      audio: mediaUrl(content.playlist[0].audio), // first item (older pages)
      items: phoneItems(content.playlist, inst.session),
      promo: promoFor(content.source),
    });

    stats.scan(campaign);
    // Only the scanned screen hides its QR
    if (inst.ws) safeSend(inst.ws, { type: "mobile_connected" });

    ws.close(1000, "Sync delivered");
    ws.on("error", () => {});
  }

  // ── /ws/drift/:campaign?instance=ID — drift correction for one phone ───────
  function handleDrift(ws, campaign, instanceId, ip) {
    const limitIp = TRUST_PROXY || !isLoopback(ip);
    if (limitIp && (phonesPerIp.get(ip) || 0) >= MAX_PHONES_PER_IP) {
      ws.close(4029, "Too many phones from this address");
      return;
    }
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
    phonesPerIp.set(ip, (phonesPerIp.get(ip) || 0) + 1);
    const listeningSince = Date.now();
    stats.listenStart(campaign);

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

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return; // "error" and "close" can both fire
      cleaned = true;
      clearInterval(interval);
      inst.drifts.delete(ws);
      stats.listenEnd(campaign, (Date.now() - listeningSince) / 1000);
      const left = (phonesPerIp.get(ip) || 1) - 1;
      if (left > 0) phonesPerIp.set(ip, left);
      else phonesPerIp.delete(ip);
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

  return { wss, computeCorrection };
}

module.exports = { attachRealtime };
