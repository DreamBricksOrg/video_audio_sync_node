/**
 * Where the media library lives. Two interchangeable stores:
 *
 *  - local: files in a folder (assets/), served by the /media route
 *  - s3:    files only in an S3 bucket (S3_BUCKET set); visitors download them
 *           from the bucket (MEDIA_BASE_URL). The server keeps an in-memory
 *           index of the bucket and only touches disk for temp files during
 *           uploads and splitting.
 *
 * Same interface: init(), list(), has(), putFile(tempPath, name), rename(),
 * remove(), localPath(), status(), tempDir, remote.
 * S3 only: registerUploaded(name) for files the browser sent straight to the
 * bucket (presigned URL).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const isMedia = exts => name => !name.startsWith(".") && exts.includes(path.extname(name).toLowerCase());
const byName = (a, b) => a.filename.localeCompare(b.filename);

function createLocalStore({ dir, exts }) {
  const accept = isMedia(exts);
  const full = name => path.join(dir, name);

  return {
    remote: false,
    tempDir: dir, // same folder, so putFile is an atomic rename
    async init() { fs.mkdirSync(dir, { recursive: true }); },
    status: () => ({ ok: true }),
    list() {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).filter(accept).map(filename => {
        const stat = fs.statSync(full(filename));
        return { filename, size: stat.size, modified: stat.mtime };
      }).sort(byName);
    },
    has: name => accept(name) && fs.existsSync(full(name)),
    async putFile(tempPath, name) { fs.renameSync(tempPath, full(name)); },
    async rename(oldName, newName) { fs.renameSync(full(oldName), full(newName)); },
    async remove(name) { fs.unlinkSync(full(name)); },
    localPath: name => (fs.existsSync(full(name)) ? full(name) : null),
    describe: () => dir,
  };
}

function createS3Store({ storage, exts }) {
  const accept = isMedia(exts);
  const index = new Map(); // filename → { filename, size, modified }
  let lastError = null;
  const tempDir = path.join(os.tmpdir(), "audiosync-uploads");

  // Reloads the bucket listing (startup and periodic refresh, to catch
  // changes made outside the admin)
  async function refresh() {
    try {
      const items = await storage.list();
      index.clear();
      items.filter(i => accept(i.filename)).forEach(i => index.set(i.filename, i));
      lastError = null;
    } catch (err) {
      lastError = err.message || err.name || String(err);
    }
  }

  return {
    remote: true,
    tempDir,
    async init() {
      fs.mkdirSync(tempDir, { recursive: true });
      await refresh();
    },
    refresh,
    status: () => (lastError ? { ok: false, error: lastError } : { ok: true }),
    list: () => [...index.values()].sort(byName),
    has: name => index.has(name),
    // Uploads the temp file, then deletes it whatever happens
    async putFile(tempPath, name) {
      try {
        const { size } = fs.statSync(tempPath);
        await storage.upload(tempPath, name);
        index.set(name, { filename: name, size, modified: new Date() });
      } finally {
        fs.rmSync(tempPath, { force: true });
      }
    },
    async rename(oldName, newName) {
      await storage.rename(oldName, newName);
      const item = index.get(oldName);
      index.delete(oldName);
      index.set(newName, { ...item, filename: newName, modified: new Date() });
    },
    async remove(name) {
      await storage.remove(name);
      index.delete(name);
    },
    // Adds a file uploaded directly to the bucket; null when it isn't there
    async registerUploaded(name) {
      const found = await storage.head(name);
      if (!found) return null;
      const item = { filename: name, size: found.size, modified: found.modified };
      index.set(name, item);
      return item;
    },
    localPath: () => null,
    describe: () => storage.describe(),
  };
}

module.exports = { createLocalStore, createS3Store };
