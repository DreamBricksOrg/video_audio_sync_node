#!/usr/bin/env node
/**
 * Simula N telas (iframes) de uma campanha e M celulares ouvindo cada tela.
 *
 *   npm run load-test -- --url http://localhost:8001 --campaign totem1 --screens 200 --phones 2 --seconds 60
 *
 * Use um servidor de teste: as telas falsas aparecem no admin enquanto o teste roda.
 * Atrás de proxy com TRUST_PROXY=1, o limite por IP (MAX_SCREENS_PER_IP) vale para este script.
 */
const WebSocket = require("ws");

function args() {
  const a = process.argv.slice(2);
  const get = (name, def) => {
    const i = a.indexOf(`--${name}`);
    return i >= 0 && a[i + 1] ? a[i + 1] : def;
  };
  return {
    url: get("url", "http://localhost:8001").replace(/\/+$/, ""),
    campaign: get("campaign", "totem1"),
    screens: parseInt(get("screens", "50"), 10),
    phones: parseInt(get("phones", "1"), 10),
    seconds: parseInt(get("seconds", "30"), 10),
  };
}

const opts = args();
const wsBase = opts.url.replace(/^http/, "ws");
const stats = { screensOk: 0, screensFailed: 0, phonesOk: 0, phonesFailed: 0, driftChecks: 0 };
const sockets = [];
const timers = [];

function openScreen(i) {
  return new Promise(resolve => {
    const instance = `load-${i}-${Math.random().toString(36).slice(2, 8)}`;
    const ws = new WebSocket(`${wsBase}/ws/screen/${opts.campaign}?instance=${instance}`);
    sockets.push(ws);
    let done = false;
    const finish = ok => {
      if (done) return;
      done = true;
      ok ? stats.screensOk++ : stats.screensFailed++;
      resolve(ok ? instance : null);
    };
    ws.on("open", () => {
      const start = Date.now();
      ws.send(JSON.stringify({ current_time: 0, duration: 30, mode: "sync", drift_enabled: true }));
      timers.push(setInterval(() => {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: "position_update", current_time: ((Date.now() - start) / 1000) % 30 }));
        }
      }, 5000));
    });
    ws.on("message", raw => { if (JSON.parse(raw).type === "session_created") finish(true); });
    ws.on("close", () => finish(false));
    ws.on("error", () => finish(false));
  });
}

function openPhone(instance) {
  return new Promise(resolve => {
    const sync = new WebSocket(`${wsBase}/ws/mobile/${opts.campaign}?instance=${instance}`);
    let got = false;
    sync.on("message", raw => { if (JSON.parse(raw).type === "sync") got = true; });
    sync.on("error", () => {});
    sync.on("close", () => {
      if (!got) { stats.phonesFailed++; return resolve(); }
      const drift = new WebSocket(`${wsBase}/ws/drift/${opts.campaign}?instance=${instance}`);
      sockets.push(drift);
      drift.on("open", () => { stats.phonesOk++; resolve(); });
      drift.on("message", raw => {
        const msg = JSON.parse(raw);
        if (msg.type !== "drift_check") return;
        stats.driftChecks++;
        drift.send(JSON.stringify({ type: "position_report", position: msg.expected_position }));
      });
      drift.on("error", () => { stats.phonesFailed++; resolve(); });
    });
  });
}

async function health() {
  try {
    return await (await fetch(`${opts.url}/health`)).json();
  } catch {
    return null;
  }
}

async function main() {
  console.log(`Abrindo ${opts.screens} telas em "${opts.campaign}" com ${opts.phones} celular(es) cada…`);
  const started = Date.now();
  const instances = [];
  for (let i = 0; i < opts.screens; i += 50) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(50, opts.screens - i) }, (_, k) => openScreen(i + k)));
    instances.push(...batch.filter(Boolean));
  }
  for (const inst of instances) {
    await Promise.all(Array.from({ length: opts.phones }, () => openPhone(inst)));
  }
  console.log(`Conectado em ${((Date.now() - started) / 1000).toFixed(1)}s`);

  const report = async () => {
    const h = await health();
    console.log(
      `telas ok=${stats.screensOk} falha=${stats.screensFailed} | ` +
      `celulares ok=${stats.phonesOk} falha=${stats.phonesFailed} | drift_checks=${stats.driftChecks}` +
      (h ? ` | servidor: telas=${h.screens_online} celulares=${h.mobile_clients} memória=${h.memory_mb}MB` : ""));
  };
  await report();
  const every = setInterval(report, 5000);

  setTimeout(async () => {
    clearInterval(every);
    timers.forEach(clearInterval);
    sockets.forEach(ws => ws.close());
    await report();
    process.exit(stats.screensFailed || stats.phonesFailed ? 1 : 0);
  }, opts.seconds * 1000);
}

main();
