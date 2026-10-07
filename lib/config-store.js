/**
 * Where the campaigns config (totems.json) lives:
 *
 *  - file: a local JSON file (written atomically)
 *  - s3:   `<prefix>/totems.json` in the media bucket, shared by every server
 *          using that bucket/prefix. Writes are conditional on the ETag last
 *          read, so a server never overwrites a newer config from another one
 *          (the caller reloads and retries instead).
 *
 * Interface: load() → config, refresh() → newer config or null, save(config).
 * The same stores keep other shared JSON documents (e.g. admin sessions) by
 * passing another file / object name.
 */
const fs = require("fs");
const { writeJsonAtomic } = require("./atomic-write");

const CONFIG_NAME = "totems.json";

const isConfigConflict = err => !!err && err.code === "PreconditionFailed";

function createFileConfigStore({ file }) {
  return {
    remote: false,
    describe: () => file,
    async load() {
      if (!fs.existsSync(file)) return {};
      return JSON.parse(fs.readFileSync(file, "utf-8") || "{}");
    },
    async refresh() { return null; }, // a local file only changes through this process
    async save(config) { writeJsonAtomic(file, config); },
  };
}

// `seed()` provides the initial config when the bucket has none yet (migration
// from the local totems.json on the first start in S3 mode).
function createS3ConfigStore({ storage, seed = () => ({}), name = CONFIG_NAME }) {
  let etag = null;

  const parse = body => (body && body.trim() ? JSON.parse(body) : {});

  async function load() {
    const current = await storage.getText(name);
    if (current) {
      etag = current.etag;
      return parse(current.body);
    }
    const initial = seed() || {};
    try {
      etag = await storage.putText(name, JSON.stringify(initial, null, 2), { ifNoneMatch: "*" });
      return initial;
    } catch (err) {
      if (isConfigConflict(err)) return load(); // another server seeded it first
      throw err;
    }
  }

  async function refresh() {
    const current = await storage.getText(name, { ifNoneMatch: etag || undefined });
    if (!current || current.notModified) return null;
    if (current.etag === etag) return null;
    etag = current.etag;
    return parse(current.body);
  }

  async function save(config) {
    const body = JSON.stringify(config, null, 2);
    etag = await storage.putText(name, body, etag ? { ifMatch: etag } : { ifNoneMatch: "*" });
  }

  return { remote: true, describe: () => `${storage.describe()}${name}`, load, refresh, save };
}

module.exports = { createFileConfigStore, createS3ConfigStore, isConfigConflict, CONFIG_NAME };
