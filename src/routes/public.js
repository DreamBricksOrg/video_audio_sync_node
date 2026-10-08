// Public routes: health check, media streaming (local mode), the QR iframe page
// and static files
const express = require("express");
const fs = require("fs");
const path = require("path");
const { STATIC_DIR, MIME_TYPES } = require("../settings");

function registerPublicRoutes(app, { instances, mediaStore, mediaUrl }) {
  // ── Health check ────────────────────────────────────────────────────────────
  app.get("/health", (req, res) => {
    const t = instances.totals();
    res.json({
      status: "ok",
      server_time: Date.now() / 1000,
      sessions: t.instances,      // instances kept in memory (open + recently closed)
      screens_online: t.online,
      mobile_clients: t.mobiles,
      uptime_s: Math.round(process.uptime()),
      memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    });
  });

  // ── Media streaming with Range support ──────────────────────────────────────
  app.get("/media/:filename", (req, res) => {
    const filename = req.params.filename;

    if (filename.startsWith(".") || filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
      return res.status(400).json({ error: "Nome de arquivo inválido" });
    }

    // S3-only: files live in the bucket — send old links / admin previews there
    if (mediaStore.remote) return res.redirect(302, mediaUrl(filename));

    const filePath = mediaStore.localPath(filename);

    if (!filePath) {
      return res.status(404).json({ error: "Arquivo não encontrado" });
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const ext = path.extname(filename).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    // No cache lifetime: clients always revalidate (cheap 304 via ETag), so a
    // replaced or renamed file is picked up on the next request.
    const etag = `"${fileSize.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const cacheHeaders = {
      "Cache-Control": "no-cache",
      "ETag": etag,
      "Last-Modified": stat.mtime.toUTCString(),
    };

    // If-Range with a stale validator → send the whole (new) file instead of a range
    const ifRange = req.headers["if-range"];
    const range = ifRange && ifRange !== etag ? null : req.headers.range;

    if (!range && req.headers["if-none-match"] === etag) {
      res.writeHead(304, cacheHeaders);
      return res.end();
    }

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
        ...cacheHeaders,
      });

      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Length": fileSize,
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
        ...cacheHeaders,
      });

      fs.createReadStream(filePath).pipe(res);
    }
  });

  // ── Static files ────────────────────────────────────────────────────────────
  app.use("/static", express.static(STATIC_DIR));
}

// Standalone QR iframe: follows the totem iframe on the same page. Registered
// early, before the admin routes.
function registerQrPage(app) {
  app.get("/qr", (req, res) => res.sendFile(path.join(STATIC_DIR, "qr.html")));
}

module.exports = { registerPublicRoutes, registerQrPage };
