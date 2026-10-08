/**
 * The media library (lib/media-store.js: S3 bucket or assets/): names, checks
 * and receiving uploads. Used by the media and campaign routes.
 */
const fs = require("fs");
const path = require("path");
const { MEDIA_EXTS, VIDEO_EXTS, MAX_UPLOAD_BYTES } = require("./settings");
const { campaignsUsing } = require("../lib/campaign-content");
const { log } = require("./log");

function createMediaLibrary({ mediaStore, campaigns }) {
  // Turns an arbitrary name into a safe "base.ext" (accents stripped, odd chars → "_")
  function sanitizeBaseName(raw) {
    const name = path.basename(String(raw || "")).trim();
    return path.basename(name, path.extname(name))
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^[._]+/, "");
  }

  function sanitizeFilename(raw) {
    const name = path.basename(String(raw || "")).trim();
    const ext = path.extname(name).toLowerCase();
    const base = sanitizeBaseName(name);
    if (!base || !MEDIA_EXTS.includes(ext)) return null;
    return base + ext;
  }

  function mediaType(filename) {
    return VIDEO_EXTS.includes(path.extname(filename).toLowerCase()) ? "video" : "audio";
  }

  // A valid media filename from a route param that exists in the library
  function mediaExists(filename) {
    if (!filename || filename.startsWith(".") || /[\\/]/.test(filename) || filename.includes("..")) return false;
    if (!MEDIA_EXTS.includes(path.extname(filename).toLowerCase())) return false;
    return mediaStore.has(filename);
  }

  function listMedia(type) {
    return mediaStore.list().map(m => m.filename).filter(f => !type || mediaType(f) === type);
  }

  // Totem ids whose config references this file (in any playlist item)
  function totemsUsing(filename) {
    return campaignsUsing(campaigns.conf, filename);
  }

  // Message for the admin when the library storage fails
  function storageErrorMessage(err) {
    const reason = err && (err.message || err.name) || "erro desconhecido";
    return mediaStore.remote ? `Falha no S3: ${reason}` : `Não foi possível salvar o arquivo: ${reason}`;
  }

  // Streams the request body into a hidden temp file (in assets/ for the local
  // store, in the OS temp folder for S3). Calls onComplete(tmpPath, received, fail)
  // once fully written; on any error the temp file is removed and an error is sent.
  function streamUploadToTemp(req, res, label, onComplete) {
    const declared = parseInt(req.headers["content-length"], 10);
    if (declared > MAX_UPLOAD_BYTES) {
      return res.status(413).json({ error: `Arquivo grande demais (máximo ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)` });
    }

    fs.mkdirSync(mediaStore.tempDir, { recursive: true });
    const tmpPath = path.join(mediaStore.tempDir, `.upload-${Date.now()}-${label}`);
    const out = fs.createWriteStream(tmpPath);
    let received = 0;
    let failed = false;

    const fail = (code, error) => {
      if (failed) return;
      failed = true;
      req.unpipe(out);
      out.destroy();
      fs.rm(tmpPath, { force: true }, () => {});
      if (!res.headersSent) res.status(code).json({ error });
    };

    req.on("data", chunk => {
      received += chunk.length;
      if (received > MAX_UPLOAD_BYTES) fail(413, "Arquivo grande demais");
    });
    req.on("aborted", () => fail(400, "Envio interrompido"));
    out.on("error", e => {
      log.error("Media", "Write failed", e);
      fail(500, "Não foi possível salvar o arquivo");
    });
    out.on("finish", () => {
      if (failed) return;
      if (received === 0) return fail(400, "Arquivo vazio");
      onComplete(tmpPath, received, fail);
    });

    req.pipe(out);
  }

  // Saves the request body as <targetName> in the library. Responds with `status` on success.
  function receiveUpload(req, res, targetName, status) {
    streamUploadToTemp(req, res, targetName, async (tmpPath, received, fail) => {
      try {
        await mediaStore.putFile(tmpPath, targetName);
      } catch (err) {
        log.error("Media", `Save ${targetName} failed:`, err);
        fs.rm(tmpPath, { force: true }, () => {});
        return fail(502, storageErrorMessage(err));
      }
      const type = mediaType(targetName);
      log.info("Media", `Saved ${type} ${targetName} (${(received / 1024 / 1024).toFixed(1)} MB)`);
      res.status(status).json({ success: true, filename: targetName, type, size: received });
    });
  }

  return {
    sanitizeBaseName, sanitizeFilename, mediaType, mediaExists, listMedia, totemsUsing,
    storageErrorMessage, streamUploadToTemp, receiveUpload,
  };
}

module.exports = { createMediaLibrary };
