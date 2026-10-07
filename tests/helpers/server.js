// Starts the real server.js on a random port with a temporary totems.json.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const sleep = ms => new Promise(r => setTimeout(r, ms));

// `media`: filenames to create (tiny placeholder files) in a temporary assets/
// folder, so configs that reference them pass the "file exists" checks.
// `files`: { name: path } real media copied into that folder (browser tests).
async function startServer({ totems = {}, env = {}, media = [], files = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audiosync-test-"));
  const assetsDir = path.join(dir, "assets");
  fs.mkdirSync(assetsDir);
  media.forEach(name => fs.writeFileSync(path.join(assetsDir, name), "placeholder"));
  Object.entries(files).forEach(([name, src]) => fs.copyFileSync(src, path.join(assetsDir, name)));
  const totemsFile = path.join(dir, "totems.json");
  fs.writeFileSync(totemsFile, JSON.stringify(totems, null, 2));
  // Empty .env: tests must never pick up the developer's real config (S3, CORS, limits…)
  const envFile = path.join(dir, ".env");
  fs.writeFileSync(envFile, "");

  const port = 20000 + Math.floor(Math.random() * 20000);
  const proc = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      TOTEMS_FILE: totemsFile,
      ENV_FILE: envFile,
      ASSETS_DIR: assetsDir,
      ADMIN_USER: "test",
      ADMIN_PASSWORD: "test-pass",
      SESSION_SECRET: "t".repeat(64),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  proc.stdout.on("data", d => (output += d));
  proc.stderr.on("data", d => (output += d));

  const base = `http://localhost:${port}`;
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try {
      await fetch(`${base}/health`);
      up = true;
    } catch {
      await sleep(100);
    }
  }
  if (!up) {
    proc.kill();
    throw new Error(`server did not start:\n${output}`);
  }

  async function login() {
    const res = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "test", password: "test-pass" }),
    });
    return res.headers.get("set-cookie").split(";")[0];
  }

  return {
    base,
    wsBase: `ws://localhost:${port}`,
    totemsFile,
    login,
    output: () => output,
    stop() {
      proc.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

module.exports = { startServer, sleep };
