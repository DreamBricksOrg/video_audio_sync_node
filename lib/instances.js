/**
 * In-memory registry of playing screens ("instances"), grouped by campaign.
 *
 * Campaign = what the admin configures (video, audio, links); stored in
 * totems.json under the totem ID. Instance = one screen playing a campaign:
 * a physical totem or one visitor's iframe. Each instance has its own sync
 * session, so every phone follows the screen whose QR it scanned.
 */

const DEFAULT_INSTANCE = "default";
const INSTANCE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function createInstanceRegistry({ now = () => Date.now() / 1000, graceSeconds = 120 } = {}) {
  const campaigns = new Map(); // campaign → Map(instanceId → instance)
  let seq = 0;                 // registration order, to find the newest instance

  function bucket(campaign, create = false) {
    let b = campaigns.get(campaign);
    if (!b && create) {
      b = new Map();
      campaigns.set(campaign, b);
    }
    return b || null;
  }

  // A screen connected (or reconnected) its WebSocket
  function register(campaign, instanceId, ws) {
    const id = INSTANCE_ID_RE.test(instanceId || "") ? instanceId : DEFAULT_INSTANCE;
    const b = bucket(campaign, true);
    let inst = b.get(id);
    if (!inst) {
      inst = { campaign, id, ws: null, session: null, drifts: new Set(), seq: 0, disconnectedAt: null };
      b.set(id, inst);
    }
    inst.ws = ws;
    inst.seq = ++seq;
    inst.disconnectedAt = null;
    return inst;
  }

  // Screen reported its video position: the session timeline uses the SERVER clock
  function startSession(inst, { current_time, duration, mode, drift_enabled } = {}) {
    const t = now();
    inst.session = {
      start_time: t - (Number(current_time) || 0),
      duration: Number(duration) || 30,
      mode: mode || "sync",
      drift_enabled: !!drift_enabled,
      created_at: t,
    };
    return inst.session;
  }

  function updatePosition(inst, currentTime) {
    if (inst.session && Number.isFinite(currentTime)) inst.session.start_time = now() - currentTime;
  }

  function get(campaign, id) {
    const b = bucket(campaign);
    return (b && b.get(id)) || null;
  }

  // Instance a phone should follow: the one from its QR, or — for QR codes
  // without an instance (printed/legacy) — the newest online one with a session
  function resolve(campaign, instanceId) {
    if (instanceId) {
      const inst = get(campaign, instanceId);
      return inst && inst.session ? inst : null;
    }
    const b = bucket(campaign);
    if (!b) return null;
    let newest = null;
    for (const inst of b.values()) {
      if (!inst.session || inst.disconnectedAt !== null) continue;
      if (!newest || inst.seq > newest.seq) newest = inst;
    }
    return newest;
  }

  // Ignores stale sockets: a reconnect may already have replaced `ws`
  function disconnect(inst, ws) {
    if (inst.ws !== ws) return;
    inst.ws = null;
    inst.disconnectedAt = now();
  }

  function online(campaign) {
    const b = bucket(campaign);
    return b ? [...b.values()].filter(i => i.ws) : [];
  }

  function campaignsOnline() {
    return [...campaigns.keys()].filter(c => online(c).length > 0);
  }

  function stats(campaign) {
    const b = bucket(campaign);
    if (!b) return { instances: 0, mobiles: 0 };
    let mobiles = 0;
    for (const inst of b.values()) mobiles += inst.drifts.size;
    return { instances: online(campaign).length, mobiles };
  }

  // Drops screens closed for longer than the grace period. Instances with
  // phones still listening are kept so their drift correction keeps working.
  function sweep() {
    const t = now();
    let removed = 0;
    for (const [campaign, b] of campaigns) {
      for (const [id, inst] of b) {
        const expired = inst.disconnectedAt !== null && t - inst.disconnectedAt >= graceSeconds;
        if (expired && inst.drifts.size === 0) {
          b.delete(id);
          removed++;
        }
      }
      if (b.size === 0) campaigns.delete(campaign);
    }
    return removed;
  }

  function totals() {
    let instances = 0, onlineCount = 0, mobiles = 0;
    for (const b of campaigns.values()) {
      for (const inst of b.values()) {
        instances++;
        if (inst.ws) onlineCount++;
        mobiles += inst.drifts.size;
      }
    }
    return { instances, online: onlineCount, mobiles };
  }

  return { register, startSession, updatePosition, get, resolve, disconnect, online, campaignsOnline, stats, sweep, totals };
}

module.exports = { createInstanceRegistry, DEFAULT_INSTANCE, INSTANCE_ID_RE };
