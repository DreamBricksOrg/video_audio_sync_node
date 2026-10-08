/**
 * Campaigns: the shared config (totems.json — a local file, or <prefix>/totems.json
 * in the bucket, shared by every server), what each campaign shows right now
 * (playlist, fallback or nothing) and sending it to the open screens.
 */
const fs = require("fs");
const { TOTEMS_FILE } = require("./settings");
const { createFileConfigStore, createS3ConfigStore, isConfigConflict } = require("../lib/config-store");
const { createSyncedDoc, SyncConflictError } = require("../lib/synced-doc");
const { activeContent, contentKey } = require("../lib/campaign-content");
const { HttpError } = require("./http-error");
const { DEFAULT_PROMO } = require("./promo");
const { safeSend } = require("./safe-send");

function createCampaigns({ storage, instances, mediaUrl }) {
  // Sends a message to every open screen of a campaign; returns how many got it
  function sendToCampaign(campaign, message) {
    const online = instances.online(campaign);
    online.forEach(inst => safeSend(inst.ws, message));
    return online.length;
  }

  // What a campaign shows right now: its playlist, its fallback campaign's
  // (outside its schedule), or null = nothing (black screen with logo)
  const contentFor = campaign => activeContent(totemsConf, campaign, new Date());

  // What a screen needs to play a campaign: the videos in order, each with the
  // audio for "Ouvir aqui". filename/url/audio = first item (older pages).
  function videoMessage(campaign) {
    const content = contentFor(campaign);
    const playlist = content ? content.playlist : [];
    const first = playlist[0] || {};
    return {
      type: "change_video",
      filename: first.video || "",
      url: mediaUrl(first.video),
      audio: mediaUrl(first.audio),
      playlist: playlist.map(i => ({ video: i.video, url: mediaUrl(i.video), audio: mediaUrl(i.audio) })),
      idle: !content,
      source: content ? content.source : null,
      key: contentKey(content),
    };
  }

  // Sends the content to the open screens of every campaign whose content
  // changed since it was last sent (config edits, other servers, schedule start/
  // end), and tells their listening phones to sync again.
  const sentContentKeys = new Map(); // campaign → key last sent to its screens
  function broadcastContent() {
    const online = new Set(instances.campaignsOnline());
    for (const id of sentContentKeys.keys()) if (!online.has(id)) sentContentKeys.delete(id);
    for (const id of online) {
      const msg = videoMessage(id);
      if (sentContentKeys.get(id) === msg.key) continue;
      sentContentKeys.set(id, msg.key);
      for (const inst of instances.online(id)) {
        safeSend(inst.ws, msg);
        notifyPhones(inst);
      }
    }
  }

  // Phones listening to an instance: what they play changed, sync again
  function notifyPhones(inst) {
    inst.drifts.forEach(ws => safeSend(ws, { type: "content_changed" }));
  }

  // ── Campaigns config (totems.json) ──────────────────────────────────────────
  // Local file, or <prefix>/totems.json in the bucket in S3 mode — shared by every
  // server using that bucket/prefix, so they can't drift apart. Loaded at startup.

  // The local file seeds the bucket the first time S3 mode starts
  function readLocalTotems() {
    try {
      return fs.existsSync(TOTEMS_FILE) ? JSON.parse(fs.readFileSync(TOTEMS_FILE, "utf-8") || "{}") : {};
    } catch (e) {
      console.error("Failed to parse totems.json", e.message);
      return {};
    }
  }

  const configStore = storage.enabled
    ? createS3ConfigStore({ storage, seed: readLocalTotems })
    : createFileConfigStore({ file: TOTEMS_FILE });

  // Map from totem Id => configuration { video, audio, promo }
  let totemsConf = {};

  // Config changed elsewhere (another server): adopt it and switch this server's
  // open screens whose content changed
  function applyRemoteConfig(next) {
    totemsConf = next;
    broadcastContent();
  }

  const configDoc = createSyncedDoc({
    store: configStore,
    isConflict: isConfigConflict,
    onChange: (prev, next) => {
      applyRemoteConfig(next);
      console.log("[Config] Reloaded (changed by another server)");
    },
  });

  async function refreshConfig() {
    try {
      await configDoc.refresh();
    } catch (e) {
      console.error("[Config] Refresh failed:", e.message);
    }
  }

  // The only way to change the config: re-read the latest version, apply
  // mutate(conf) to a copy, save it conditionally, and retry if another server
  // saved in between. mutate may throw HttpError; its return value is passed on.
  async function mutateConfig(mutate) {
    try {
      return await configDoc.mutate(mutate);
    } catch (err) {
      if (err instanceof SyncConflictError) {
        throw new HttpError(409, "A configuração foi alterada ao mesmo tempo em outro servidor. Tente de novo.");
      }
      throw err;
    } finally {
      totemsConf = configDoc.get();
      broadcastContent(); // open screens follow the new config right away
    }
  }

  // Schedules start and end on their own: check every few seconds
  setInterval(broadcastContent, 5000).unref();

  // HttpError → its status; anything else = the config storage failed
  function sendError(res, err, context) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
    console.error(`[${context}]`, err.message);
    res.status(502).json({
      error: configStore.remote
        ? `Não foi possível salvar a configuração no S3: ${err.message}`
        : "Não foi possível salvar a configuração",
    });
  }

  // Phone page text/links: the campaign's own, or the default ones
  function promoFor(id) {
    return (totemsConf[id] && totemsConf[id].promo) || DEFAULT_PROMO;
  }

  async function load() {
    totemsConf = await configDoc.load();
    return totemsConf;
  }

  return {
    get conf() { return totemsConf; },
    configStore, load, refreshConfig, mutateConfig, sendError,
    contentFor, videoMessage, broadcastContent, notifyPhones, sendToCampaign, sentContentKeys, promoFor,
  };
}

module.exports = { createCampaigns };
