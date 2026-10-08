// Crash-safe JSON write: write a temp file next to the target, flush it to
// disk, then rename over the target. A crash mid-write leaves the old file
// intact instead of a truncated/corrupted one.
const fs = require("fs");
const path = require("path");

// On Windows a rename over a file that another process has open for a moment
// (antivirus, indexer) fails with EPERM/EBUSY/EACCES: wait a little and retry
const BUSY = new Set(["EPERM", "EBUSY", "EACCES"]);
function renameWithRetry(from, to, attempts = 8) {
  for (let i = 1; ; i++) {
    try {
      return fs.renameSync(from, to);
    } catch (err) {
      if (!BUSY.has(err.code) || i >= attempts) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * i);
    }
  }
}

function writeJsonAtomic(file, data) {
  const json = JSON.stringify(data, null, 2); // may throw before touching disk
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeSync(fd, json, null, "utf-8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    renameWithRetry(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

module.exports = { writeJsonAtomic };
