// Admin API for the media library: list, upload (direct to S3 or through the
// server), split video/audio, replace, rename, delete
const fs = require("fs");
const path = require("path");
const { MEDIA_EXTS, MAX_UPLOAD_BYTES } = require("../settings");
const { splitMedia, INPUT_EXTS: SPLIT_INPUT_EXTS } = require("../../lib/media-splitter");
const { renameInConfig } = require("../../lib/campaign-content");

function registerMediaRoutes(app, { storage, mediaStore, library, campaigns }) {
  const {
    sanitizeBaseName, sanitizeFilename, mediaType, mediaExists, totemsUsing,
    storageErrorMessage, streamUploadToTemp, receiveUpload,
  } = library;
  const { refreshConfig, mutateConfig } = campaigns;

  // List: GET /api/media
  app.get("/api/media", (req, res) => {
    const status = mediaStore.status();
    if (!status.ok) return res.status(503).json({ error: storageErrorMessage({ message: status.error }) });
    res.json(mediaStore.list().map(m => ({
      filename: m.filename,
      type: mediaType(m.filename),
      size: m.size,
      modified: m.modified ? new Date(m.modified).toISOString() : null,
      used_by: totemsUsing(m.filename),
    })));
  });

  // Create: POST /api/media?filename=promo.mp4[&overwrite=1]  (raw body)
  app.post("/api/media", (req, res) => {
    const filename = sanitizeFilename(req.query.filename);
    if (!filename) {
      return res.status(400).json({ error: `Arquivo inválido. Permitidos: ${MEDIA_EXTS.join(", ")}` });
    }
    const overwrite = req.query.overwrite === "1" || req.query.overwrite === "true";
    if (mediaStore.has(filename) && !overwrite) {
      return res.status(409).json({ error: "O arquivo já existe", filename });
    }
    receiveUpload(req, res, filename, 201);
  });

  // Direct upload (S3 mode): the browser sends the file straight to the bucket,
  // so big videos don't pass through this server.
  //   1. POST /api/media/upload-url { filename, size, overwrite?, replace? }
  //      → { direct: true, filename, url, headers, expires_in }  (local mode: { direct: false })
  //   2. browser PUTs the file to `url` with `headers`
  //   3. POST /api/media/upload-complete { filename } → the file joins the library
  // `replace` = existing file whose content is replaced (keeps its name).
  const DIRECT_UPLOAD_EXPIRES_S = 600;

  app.post("/api/media/upload-url", async (req, res) => {
    if (!mediaStore.remote) return res.json({ direct: false });
    const { filename: raw, size, overwrite, replace } = req.body || {};

    let filename;
    if (replace) {
      if (!mediaExists(replace)) return res.status(404).json({ error: "Arquivo não encontrado" });
      const ext = path.extname(String(raw || "")).toLowerCase();
      if (ext !== path.extname(replace).toLowerCase()) {
        return res.status(400).json({ error: `"${replace}" só pode ser substituído por outro arquivo ${path.extname(replace)}` });
      }
      filename = replace;
    } else {
      filename = sanitizeFilename(raw);
      if (!filename) return res.status(400).json({ error: `Arquivo inválido. Permitidos: ${MEDIA_EXTS.join(", ")}` });
      if (mediaStore.has(filename) && !overwrite) return res.status(409).json({ error: "O arquivo já existe", filename });
    }

    if (!Number.isInteger(size) || size <= 0) return res.status(400).json({ error: "Arquivo vazio" });
    if (size > MAX_UPLOAD_BYTES) {
      return res.status(413).json({ error: `Arquivo grande demais (máximo ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)` });
    }

    try {
      const signed = await storage.presignPut(filename, { size, expiresIn: DIRECT_UPLOAD_EXPIRES_S });
      res.json({ direct: true, filename, url: signed.url, headers: signed.headers, expires_in: signed.expiresIn });
    } catch (err) {
      console.error(`[Media] Sign upload ${filename} failed:`, err.message);
      res.status(502).json({ error: storageErrorMessage(err) });
    }
  });

  app.post("/api/media/upload-complete", async (req, res) => {
    if (!mediaStore.remote) return res.status(400).json({ error: "Envio direto só existe no modo S3" });
    const filename = String((req.body || {}).filename || "");
    if (sanitizeFilename(filename) !== filename) return res.status(400).json({ error: "Arquivo inválido" });
    try {
      const item = await mediaStore.registerUploaded(filename);
      if (!item) return res.status(404).json({ error: "O arquivo não chegou ao S3. Tente enviar de novo." });
      const type = mediaType(filename);
      console.log(`[Media] Saved ${type} ${filename} (${(item.size / 1024 / 1024).toFixed(1)} MB, direct to S3)`);
      res.status(201).json({ success: true, filename, type, size: item.size });
    } catch (err) {
      console.error(`[Media] Register ${filename} failed:`, err.message);
      res.status(502).json({ error: storageErrorMessage(err) });
    }
  });

  // Split: POST /api/media/split?filename=promo.mov[&overwrite=1]  (raw body)
  // Uploads a video WITH audio and saves it as <name>_video.<ext> + <name>_audio.mp3.
  // The original upload is not kept.
  app.post("/api/media/split", (req, res) => {
    const raw = path.basename(String(req.query.filename || "")).trim();
    const ext = path.extname(raw).toLowerCase();
    const base = sanitizeBaseName(raw);
    if (!base || !SPLIT_INPUT_EXTS.includes(ext)) {
      return res.status(400).json({ error: `Arquivo inválido. Envie um vídeo com áudio: ${SPLIT_INPUT_EXTS.join(", ")}` });
    }

    // Check the likely output names before receiving a possibly large file
    const overwrite = req.query.overwrite === "1" || req.query.overwrite === "true";
    const videoName = `${base}_video${ext === ".webm" ? ".webm" : ".mp4"}`;
    const audioName = `${base}_audio.mp3`;
    const existing = [videoName, audioName].filter(f => mediaStore.has(f));
    if (existing.length && !overwrite) {
      return res.status(409).json({ error: "Já existem arquivos com esses nomes", files: existing });
    }

    streamUploadToTemp(req, res, `${base}${ext}`, async (tmpPath, received) => {
      const started = Date.now();
      // Outputs go to a scratch folder first, then into the library
      const workDir = fs.mkdtempSync(path.join(mediaStore.tempDir, ".split-"));
      try {
        const web = req.query.web === "1" || req.query.web === "true";
        const result = await splitMedia(tmpPath, { outDir: workDir, baseName: base, overwrite: true, web });
        const video = path.basename(result.video);
        const audio = path.basename(result.audio);
        if (!overwrite && (mediaStore.has(video) || mediaStore.has(audio))) {
          return res.status(409).json({ error: "Já existem arquivos com esses nomes", files: [video, audio].filter(f => mediaStore.has(f)) });
        }
        try {
          await mediaStore.putFile(result.video, video);
          await mediaStore.putFile(result.audio, audio);
        } catch (err) {
          console.error("[Media] Split save failed:", err.message);
          return res.status(502).json({ error: storageErrorMessage(err) });
        }
        console.log(`[Media] Split ${raw} (${(received / 1024 / 1024).toFixed(1)} MB) → ${video} + ${audio}` +
          `${result.transcoded ? " (video re-encoded)" : ""} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
        res.status(201).json({ success: true, video, audio, transcoded: result.transcoded, web: result.web, duration: result.duration });
      } catch (err) {
        console.error("[Media] Split failed:", err.message);
        const userError = /não tem faixa|não suportado|Já existe/.test(err.message);
        res.status(userError ? 400 : 500).json({
          error: userError ? err.message : "Não foi possível separar o vídeo e o áudio",
        });
      } finally {
        fs.rm(tmpPath, { force: true }, () => {});
        fs.rm(workDir, { recursive: true, force: true }, () => {});
      }
    });
  });

  // Replace content: PUT /api/media/:filename  (raw body, keeps the name)
  app.put("/api/media/:filename", (req, res) => {
    if (!mediaExists(req.params.filename)) return res.status(404).json({ error: "Arquivo não encontrado" });
    receiveUpload(req, res, req.params.filename, 200);
  });

  // Rename: PATCH /api/media/:filename  { "filename": "new-name.mp4" }
  app.patch("/api/media/:filename", async (req, res) => {
    const oldName = req.params.filename;
    if (!mediaExists(oldName)) return res.status(404).json({ error: "Arquivo não encontrado" });

    const newName = sanitizeFilename(req.body && req.body.filename);
    if (!newName) return res.status(400).json({ error: `Nome inválido. Permitidos: ${MEDIA_EXTS.join(", ")}` });
    if (mediaType(newName) !== mediaType(oldName)) {
      return res.status(400).json({ error: `${mediaType(oldName) === "video" ? "Um vídeo precisa continuar com extensão de vídeo" : "Um áudio precisa continuar com extensão de áudio"}` });
    }
    if (newName === oldName) return res.json({ success: true, filename: newName, updated_totems: [] });
    if (mediaStore.has(newName)) {
      return res.status(409).json({ error: "Já existe um arquivo com esse nome", filename: newName });
    }

    try {
      await mediaStore.rename(oldName, newName);
    } catch (e) {
      console.error("[Media] Rename failed", e.message);
      return res.status(502).json({ error: storageErrorMessage(e) });
    }

    // Keep totem configs pointing at the file under its new name
    let updated = [];
    try {
      await refreshConfig();
      if (totemsUsing(oldName).length) {
        // Open screens get the new names (mutateConfig → broadcastContent)
        updated = await mutateConfig(conf => renameInConfig(conf, oldName, newName));
      }
    } catch (err) {
      console.error("[Media] Rename: config update failed", err.message);
      return res.status(502).json({ error: `Arquivo renomeado, mas não foi possível atualizar os totens: ${err.message}` });
    }

    console.log(`[Media] Renamed ${oldName} → ${newName}${updated.length ? ` (totems: ${updated.join(", ")})` : ""}`);
    res.json({ success: true, filename: newName, updated_totems: updated });
  });

  // Delete: DELETE /api/media/:filename  (refused while a totem uses it)
  app.delete("/api/media/:filename", async (req, res) => {
    const filename = req.params.filename;
    if (!mediaExists(filename)) return res.status(404).json({ error: "Arquivo não encontrado" });

    await refreshConfig(); // another server may have just assigned it
    const usedBy = totemsUsing(filename);
    if (usedBy.length) {
      return res.status(409).json({ error: "O arquivo está em uso por um totem", used_by: usedBy });
    }

    try {
      await mediaStore.remove(filename);
    } catch (e) {
      console.error("[Media] Delete failed", e.message);
      return res.status(502).json({ error: storageErrorMessage(e) });
    }
    console.log(`[Media] Deleted ${filename}`);
    res.json({ success: true, filename });
  });
}

module.exports = { registerMediaRoutes };
