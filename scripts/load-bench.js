#!/usr/bin/env node
/**
 * Local capacity check: starts a throwaway server (temporary config, no .env,
 * no S3) and runs scripts/load-test.js against it at a few sizes, measuring
 * memory, CPU and how long /health takes to answer while under load.
 *
 *   npm run load-bench                      # default sizes
 *   npm run load-bench -- 200x1 1000x2      # screens x phones-per-screen
 *
 * Never point it at production: use npm run load-test with --url for that.
 */
const { execFile } = require("child_process");
const path = require("path");
const { startServer } = require("../tests/helpers/server");

const sizes = (process.argv.slice(2).length ? process.argv.slice(2) : ["200x1", "500x2", "1000x2"])
  .map(s => s.split("x").map(Number));
const SECONDS = 20;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function healthProbe(base, ms) {
  const times = [];
  let last = null;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) {
    const t = process.hrtime.bigint();
    last = await (await fetch(`${base}/health`)).json();
    times.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  times.sort((a, b) => a - b);
  const p = q => times[Math.min(times.length - 1, Math.floor(q * times.length))].toFixed(1);
  return { p50: p(0.5), p95: p(0.95), max: times[times.length - 1].toFixed(1), last };
}

function cpuOf(pid) {
  // Process CPU time in seconds (Windows: wmic is gone, use PowerShell; Linux/macOS: ps)
  return new Promise(resolve => {
    if (process.platform === "win32") {
      execFile("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).TotalProcessorTime.TotalSeconds`],
        (err, out) => resolve(err ? NaN : parseFloat(String(out).replace(",", "."))));
    } else {
      execFile("ps", ["-o", "cputime=", "-p", String(pid)], (err, out) => {
        if (err) return resolve(NaN);
        const parts = String(out).trim().split(":").map(Number);
        resolve(parts.reduce((t, v) => t * 60 + v, 0));
      });
    }
  });
}

(async () => {
  const server = await startServer({
    totems: { carga: { video: "v.mp4", audio: "a.mp3" } },
    media: ["v.mp4", "a.mp3"],
  });
  const pid = server.pid;
  console.log(`Servidor de teste em ${server.base} (pid ${pid})\n`);
  console.log("telas  celulares  conectou  falhas  memória   CPU      /health p50 / p95 / máx (ms)");
  try {
    for (const [screens, phones] of sizes) {
      const cpuBefore = await cpuOf(pid);
      const started = Date.now();
      const run = new Promise(resolve => {
        execFile(process.execPath, [path.join(__dirname, "load-test.js"),
          "--url", server.base, "--campaign", "carga", "--screens", String(screens), "--phones", String(phones), "--seconds", String(SECONDS)],
        { maxBuffer: 10 * 1024 * 1024 }, (err, out) => resolve(String(out)));
      });
      await sleep(3000); // let the connections open
      const probe = await healthProbe(server.base, (SECONDS - 4) * 1000);
      const out = await run;
      const cpu = (await cpuOf(pid)) - cpuBefore;
      const elapsed = (Date.now() - started) / 1000;
      const lines = out.trim().split("\n");
      const final = lines[lines.length - 1];
      const connected = (out.match(/Conectado em ([\d.]+)s/) || [])[1] || "?";
      const failed = (final.match(/falha=(\d+)/g) || []).map(m => +m.split("=")[1]).reduce((a, b) => a + b, 0);
      console.log(
        `${String(screens).padEnd(6)} ${String(screens * phones).padEnd(10)} ${(connected + "s").padEnd(9)} ${String(failed).padEnd(7)} ` +
        `${(probe.last.memory_mb + " MB").padEnd(9)} ${((cpu / elapsed * 100).toFixed(0) + "%").padEnd(8)} ${probe.p50} / ${probe.p95} / ${probe.max}`,
      );
      await sleep(3000); // let sockets close before the next size
    }
  } finally {
    server.stop();
  }
})();
