// Admin API for campaigns (totems): list with status, create, edit (playlist,
// schedule, rename), delete, phone page links
const { HttpError } = require("../http-error");
const { DEFAULT_PROMO, PROMO_ICONS, PROMO_MAX_LINKS, sanitizePromo } = require("../promo");
const { playlistOf, withPlaylist, sanitizePlaylist, sanitizeSchedule } = require("../../lib/campaign-content");

function registerCampaignRoutes(app, { instances, mediaStore, library, campaigns }) {
  const { listMedia } = library;
  const { mutateConfig, sendError, contentFor, promoFor, sendToCampaign } = campaigns;

  // Get totems list & states
  app.get("/api/totems", (req, res) => {
    // Saved campaigns + campaigns with open screens that were never saved
    const allIds = new Set([...Object.keys(campaigns.conf), ...instances.campaignsOnline()]);

    res.json([...allIds].map(id => {
      const { instances: openScreens, mobiles } = instances.stats(id);
      const content = contentFor(id);
      return {
        id,
        configured: !!campaigns.conf[id], // false = online but never saved in the admin
        is_online: openScreens > 0,
        instances: openScreens,       // screens/iframes playing right now
        mobile_count: mobiles,        // phones listening (drift sockets)
        video: campaigns.conf[id] ? campaigns.conf[id].video : null,
        audio: campaigns.conf[id] ? campaigns.conf[id].audio : null,
        playlist: playlistOf(campaigns.conf[id]),     // videos in order, each with its audio
        schedule: (campaigns.conf[id] && campaigns.conf[id].schedule) || null,
        showing: content ? content.source : null, // own id, the fallback's, or null (nothing on air)
        missing: missingMedia(campaigns.conf[id]), // configured files not in the library
        promo: promoFor(id),
      };
    }));
  });

  // Promo options for the admin editor (icon list, limits, defaults)
  app.get("/api/promo/options", (req, res) => {
    res.json({ icons: PROMO_ICONS, max_links: PROMO_MAX_LINKS, defaults: DEFAULT_PROMO });
  });

  // Update the mobile page text/links for a totem
  app.put("/api/totem/:id/promo", async (req, res) => {
    const { id } = req.params;
    const { promo, error } = sanitizePromo(req.body);
    if (error) return res.status(400).json({ error });

    try {
      await mutateConfig(conf => {
        if (!conf[id]) conf[id] = {};
        conf[id].promo = promo;
      });
    } catch (err) {
      return sendError(res, err, "Admin");
    }

    console.log(`[Admin] Updated mobile links for totem ${id} (${promo.links.length} links)`);
    res.json({ success: true, id, promo });
  });

  // Update specific totem's config: { playlist: [{ video, audio }] } or { video, audio }
  app.post("/api/totem/:id/config", async (req, res) => {
    const { id } = req.params;
    const body = req.body || {};
    const input = Array.isArray(body.playlist) ? body.playlist : [{ video: body.video, audio: body.audio }];
    if (!input.length || !input.every(i => i && i.video && i.audio)) {
      return res.status(400).json({ error: "Escolha um vídeo e um áudio" });
    }
    const { playlist, error } = sanitizePlaylist(input, mediaLibrary());
    if (error) return res.status(400).json({ error });

    try {
      await mutateConfig(conf => {
        conf[id] = withPlaylist(conf[id] || {}, playlist);
      });
    } catch (err) {
      return sendError(res, err, "Admin");
    }

    // Open screens switch right away (mutateConfig → broadcastContent)
    console.log(`[Admin] Assigned ${playlist.map(i => `${i.video}+${i.audio}`).join(", ")} to totem ${id}`);
    res.json({ success: true, id, video: playlist[0].video, audio: playlist[0].audio, playlist });
  });

  // ── Totems CRUD ─────────────────────────────────────────────────────────────
  // IDs go into URLs (?screen=ID) and the admin markup, so keep them simple
  const TOTEM_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

  // Files a totem config references that aren't in the library (e.g. renamed or
  // deleted by another server sharing the bucket). Empty while the library is
  // unavailable, to avoid false alarms.
  function missingMedia(conf) {
    if (!conf || !mediaStore.status().ok) return [];
    const files = [conf.video, conf.audio, ...playlistOf(conf).flatMap(i => [i.video, i.audio])];
    return [...new Set(files)].filter(f => f && !mediaStore.has(f));
  }

  const mediaLibrary = () => ({ videos: listMedia("video"), audios: listMedia("audio") });

  // The playlist / schedule of a create or update request → { playlist?, schedule? }
  // (absent = not sent), or { error }
  function campaignFields(body, id, campaignIds) {
    const out = {};
    if (body.playlist !== undefined) {
      const r = sanitizePlaylist(body.playlist, mediaLibrary());
      if (r.error) return { error: r.error };
      out.playlist = r.playlist;
    } else {
      const err = validateTotemMedia(body.video, body.audio);
      if (err) return { error: err };
    }
    if (body.schedule !== undefined) {
      const r = sanitizeSchedule(body.schedule, id, campaignIds);
      if (r.error) return { error: r.error };
      out.schedule = r.schedule;
    }
    return out;
  }

  function applyCampaignFields(conf, body, fields) {
    let next = { ...conf };
    if (fields.playlist) {
      next = withPlaylist(next, fields.playlist);
    } else {
      if (body.video !== undefined) next.video = body.video || "";
      if (body.audio !== undefined) next.audio = body.audio || "";
      // Editing the first video/audio the old way keeps the rest of the playlist
      if (Array.isArray(next.playlist) && next.playlist.length) {
        next.playlist = [{ video: next.video, audio: next.audio }, ...next.playlist.slice(1)];
      }
    }
    if (fields.schedule !== undefined) {
      if (fields.schedule) next.schedule = fields.schedule;
      else delete next.schedule;
    }
    return next;
  }

  // Checks optional video/audio fields against the library. Returns an error string or null.
  function validateTotemMedia(video, audio) {
    if (video && !listMedia("video").includes(video)) return `Vídeo não encontrado: ${video}`;
    if (audio && !listMedia("audio").includes(audio)) return `Áudio não encontrado: ${audio}`;
    return null;
  }

  // Create: POST /api/totems  { id, video?, audio?, playlist?, schedule? }
  app.post("/api/totems", async (req, res) => {
    const body = req.body || {};
    const { id } = body;
    if (!TOTEM_ID_RE.test(id || "")) {
      return res.status(400).json({ error: "O ID deve ter de 1 a 40 letras, números, - ou _" });
    }
    const fields = campaignFields(body, id, Object.keys(campaigns.conf));
    if (fields.error) return res.status(400).json({ error: fields.error });

    let created;
    try {
      await mutateConfig(conf => {
        if (conf[id]) throw new HttpError(409, `O totem "${id}" já existe`);
        created = applyCampaignFields({ video: "", audio: "" }, body, fields);
        conf[id] = created;
      });
    } catch (err) {
      return sendError(res, err, "Admin");
    }
    // Screens already open under this ID pick up the video right away (broadcastContent)
    console.log(`[Admin] Created totem ${id}`);
    res.status(201).json({ success: true, id, ...created, playlist: playlistOf(created) });
  });

  // Update: PATCH /api/totem/:id  { id?, video?, audio? }  — `id` renames the totem
  app.patch("/api/totem/:id", async (req, res) => {
    const oldId = req.params.id;
    const body = req.body || {};
    const newId = body.id === undefined ? oldId : String(body.id).trim();
    if (!TOTEM_ID_RE.test(newId)) {
      return res.status(400).json({ error: "O ID deve ter de 1 a 40 letras, números, - ou _" });
    }
    const ids = Object.keys(campaigns.conf).map(k => (k === oldId ? newId : k));
    const fields = campaignFields(body, newId, ids);
    if (fields.error) return res.status(400).json({ error: fields.error });

    let conf;
    try {
      conf = await mutateConfig(all => {
        if (!all[oldId]) throw new HttpError(404, "Totem não encontrado");
        if (newId !== oldId && all[newId]) throw new HttpError(409, `O totem "${newId}" já existe`);
        const next = applyCampaignFields(all[oldId], body, fields);
        if (newId !== oldId) {
          delete all[oldId];
          // Campaigns falling back to this one follow the new name
          for (const c of Object.values(all)) {
            if (c.schedule && c.schedule.fallback === oldId) c.schedule = { ...c.schedule, fallback: newId };
          }
        }
        all[newId] = next;
        return next;
      });
    } catch (err) {
      return sendError(res, err, "Admin");
    }

    // Content changes reach open screens through mutateConfig → broadcastContent
    if (newId !== oldId) {
      // Every open screen reloads itself with ?screen=<newId>
      sendToCampaign(oldId, { type: "change_screen", screen: newId });
    }

    console.log(`[Admin] Updated totem ${oldId}${newId !== oldId ? ` → ${newId}` : ""}`);
    res.json({ success: true, id: newId, renamed_from: newId !== oldId ? oldId : undefined, ...conf, playlist: playlistOf(conf) });
  });

  // Delete: DELETE /api/totem/:id  — removes the saved config (video, audio, links)
  app.delete("/api/totem/:id", async (req, res) => {
    const { id } = req.params;
    try {
      await mutateConfig(conf => {
        if (!conf[id]) throw new HttpError(404, "Totem não encontrado");
        delete conf[id];
        // Campaigns falling back to it now show nothing outside their period
        for (const c of Object.values(conf)) {
          if (c.schedule && c.schedule.fallback === id) c.schedule = { ...c.schedule, fallback: null };
        }
      });
    } catch (err) {
      return sendError(res, err, "Admin");
    }
    console.log(`[Admin] Deleted totem ${id}`);
    res.json({ success: true, id, still_online: instances.online(id).length > 0 });
  });
}

module.exports = { registerCampaignRoutes };
