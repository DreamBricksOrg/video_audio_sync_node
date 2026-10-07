/**
 * What a campaign plays, and when.
 *
 * Config of one campaign (totems.json):
 *   { video, audio,                    ← first playlist item (also the old format)
 *     playlist: [{ video, audio }, …], ← only when there are 2+ items
 *     schedule: { start, end, fallback }, promo }
 *
 * Videos play in order and loop; each video has its own audio for the phones.
 * Outside its schedule (ISO dates, UTC) a campaign shows its `fallback`
 * campaign's content, or nothing (black screen with logo).
 */
const MAX_PLAYLIST = 20;
const MAX_FALLBACK_DEPTH = 3;

function playlistOf(conf) {
  if (!conf) return [];
  if (Array.isArray(conf.playlist) && conf.playlist.length) {
    return conf.playlist.filter(i => i && i.video).map(i => ({ video: i.video, audio: i.audio || "" }));
  }
  return conf.video ? [{ video: conf.video, audio: conf.audio || "" }] : [];
}

// Returns a copy of `conf` playing `playlist`
function withPlaylist(conf, playlist) {
  const next = { ...conf, video: playlist[0] ? playlist[0].video : "", audio: playlist[0] ? playlist[0].audio : "" };
  if (playlist.length > 1) next.playlist = playlist.map(i => ({ video: i.video, audio: i.audio || "" }));
  else delete next.playlist;
  return next;
}

function isOnAir(schedule, now) {
  if (!schedule) return true;
  const t = now.getTime();
  if (schedule.start && t < Date.parse(schedule.start)) return false;
  if (schedule.end && t >= Date.parse(schedule.end)) return false;
  return true;
}

// { source, playlist } of what `id` shows at `now`, or null (nothing on air)
function activeContent(confs, id, now, seen = new Set()) {
  const conf = confs[id];
  if (!conf || seen.has(id) || seen.size > MAX_FALLBACK_DEPTH) return null;
  seen.add(id);
  if (isOnAir(conf.schedule, now)) {
    const playlist = playlistOf(conf);
    return playlist.length ? { source: id, playlist } : null;
  }
  const fallback = conf.schedule && conf.schedule.fallback;
  return fallback ? activeContent(confs, fallback, now, seen) : null;
}

const contentKey = content => (content ? JSON.stringify([content.source, content.playlist]) : "idle");

function usesFile(conf, filename) {
  return conf.video === filename || conf.audio === filename ||
    playlistOf(conf).some(i => i.video === filename || i.audio === filename);
}

function campaignsUsing(confs, filename) {
  return Object.keys(confs).filter(id => usesFile(confs[id], filename));
}

// Renames a media file everywhere (mutates confs); returns the changed ids
function renameInConfig(confs, oldName, newName) {
  const changed = campaignsUsing(confs, oldName);
  const swap = f => (f === oldName ? newName : f);
  for (const id of changed) {
    const conf = confs[id];
    conf.video = swap(conf.video);
    conf.audio = swap(conf.audio);
    if (Array.isArray(conf.playlist)) conf.playlist = conf.playlist.map(i => ({ video: swap(i.video), audio: swap(i.audio) }));
  }
  return changed;
}

// Admin input → { playlist } or { error }; `library` = { videos, audios }
function sanitizePlaylist(input, library) {
  if (!Array.isArray(input)) return { error: "A lista de vídeos é inválida" };
  if (input.length > MAX_PLAYLIST) return { error: `No máximo ${MAX_PLAYLIST} vídeos por campanha` };
  const playlist = [];
  for (const [i, raw] of input.entries()) {
    const video = String((raw && raw.video) || "");
    const audio = String((raw && raw.audio) || "");
    if (!video) return { error: `Item ${i + 1}: escolha um vídeo` };
    if (!library.videos.includes(video)) return { error: `Vídeo não encontrado: ${video}` };
    if (audio && !library.audios.includes(audio)) return { error: `Áudio não encontrado: ${audio}` };
    playlist.push({ video, audio });
  }
  return { playlist };
}

// Admin input → { schedule } (null = always on air) or { error }
function sanitizeSchedule(input, id, campaignIds) {
  if (!input || typeof input !== "object") return { schedule: null };
  const date = (v, label) => {
    if (!v) return null;
    const t = Date.parse(v);
    if (Number.isNaN(t)) throw new Error(`Data de ${label} inválida`);
    return new Date(t).toISOString();
  };
  try {
    const start = date(input.start, "início");
    const end = date(input.end, "fim");
    if (start && end && end <= start) throw new Error("O fim precisa ser depois do início");
    const fallback = input.fallback ? String(input.fallback) : null;
    if (fallback === id) throw new Error("A campanha não pode ser a própria campanha padrão");
    if (fallback && !campaignIds.includes(fallback)) throw new Error(`A campanha padrão "${fallback}" não existe`);
    if (!start && !end && !fallback) return { schedule: null };
    return { schedule: { start, end, fallback } };
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = {
  playlistOf, withPlaylist, isOnAir, activeContent, contentKey, campaignsUsing, renameInConfig,
  sanitizePlaylist, sanitizeSchedule, MAX_PLAYLIST,
};
