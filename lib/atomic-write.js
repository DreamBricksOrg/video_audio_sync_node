// Crash-safe JSON write: write a temp file next to the target, flush it to
// disk, then rename over the target. A crash mid-write leaves the old file
// intact instead of a truncated/corrupted one.
const fs = require("fs");
const path = require("path");

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
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

module.exports = { writeJsonAtomic };
