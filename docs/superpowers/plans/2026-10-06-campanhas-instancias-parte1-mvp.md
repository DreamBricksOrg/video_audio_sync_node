# Campanhas e Instâncias — Parte 1 (MVP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir que o mesmo link de totem seja aberto por N telas ao mesmo tempo (N visitantes de um site, cada um com seu iframe), cada tela com sua própria sessão de sincronia, e o celular de cada visitante sincronizando com a tela *dele*.

**Architecture:** Separamos **campanha** (o "totem" configurado no admin: vídeo, áudio, links) de **instância** (uma tela tocando a campanha: um iframe ou um totem físico). Um novo módulo `lib/instances.js` guarda, em memória, as instâncias por campanha, cada uma com sua sessão (`start_time`, `duration`) e seus celulares de drift. A página do totem gera um ID de instância por carregamento e o coloca no WebSocket e no QR; o celular usa esse ID para sincronizar. Celular sem ID (QR impresso / link antigo) cai na instância mais recente da campanha, mantendo o totem físico funcionando.

**Tech Stack:** Node.js 22, Express 4, `ws` 8, testes com `node:test` (embutido no Node, sem dependência nova).

**Branch:** `feat/campaign-instances` (já criada a partir da `main`).

**Commits:** sem trailer `Co-Authored-By` (preferência do usuário).

---

## Contexto para quem vai implementar

- `server.js` é um arquivo único com Express + WebSockets. Hoje as sessões ficam em mapas indexados só pelo ID do totem: `sessions`, `screenClients`, `mobileClients`, `driftClients` (perto da linha 70). Por isso duas telas do mesmo totem se sobrescrevem.
- WebSockets (seção `// ── WebSocket server` no fim do `server.js`):
  - `/ws/screen/:id` — a página do totem se registra, manda `current_time` e recebe `change_video`, `change_screen`, `mobile_connected`.
  - `/ws/mobile/:id` — o celular recebe um `sync` (start_time, duration, audio, promo) e a conexão fecha.
  - `/ws/drift/:id` — o celular fica conectado recebendo `drift_check` a cada 2s e mandando `position_report`.
- Páginas: `static/totem.html` + `static/js/totem.js`; `static/mobile.html` + `static/js/mobile.js`; `static/mobile_debug.html` + `static/js/mobile_debug.js`; admin em `static/admin.html` + `static/js/admin.js`.
- No código, "totem" e "screen" continuam sendo o nome da **campanha** (não vamos renomear rotas nem o arquivo `totems.json` no MVP).
- Rodar o servidor: `npm run dev`. Não existe suíte de testes ainda — a Task 1 cria.

## Mapa de arquivos

| Arquivo | Ação | Responsabilidade |
|---|---|---|
| `lib/instances.js` | Criar | Registro em memória de instâncias por campanha (sessão, socket da tela, celulares de drift, limpeza) |
| `tests/instances.test.js` | Criar | Testes unitários do registro |
| `tests/helpers/server.js` | Criar | Sobe o `server.js` real numa porta aleatória com `totems.json` temporário |
| `tests/helpers/ws.js` | Criar | Helpers de WebSocket para testes (tela, celular, drift) |
| `tests/instances.integration.test.js` | Criar | Testes ponta a ponta das instâncias via WebSocket e API |
| `package.json` | Modificar | Script `npm test` |
| `server.js` | Modificar | `TOTEMS_FILE` via env; usar o registro em todos os WS, broadcasts, `/api/totems` e `/health` |
| `static/js/totem.js` | Modificar | Gerar ID de instância; usar no WS e no QR |
| `static/js/mobile.js` | Modificar | Ler `instance` da URL; drift usa a instância devolvida no `sync` |
| `static/js/mobile_debug.js` | Modificar | Mesmo que o mobile + mostrar a instância no selo |
| `static/js/admin.js` | Modificar | Mostrar "Telas abertas" no card |

---

### Task 1: Infra de testes e `TOTEMS_FILE` configurável

Os testes de integração sobem o servidor de verdade; ele não pode escrever no `totems.json` do projeto.

**Files:**
- Modify: `server.js` (linha `const TOTEMS_FILE = ...`, perto da linha 71)
- Modify: `package.json`
- Create: `tests/helpers/server.js`
- Create: `tests/helpers/ws.js`
- Create: `tests/smoke.integration.test.js`

- [ ] **Step 1: Tornar o arquivo de configuração configurável**

Em `server.js`, troque:

```js
const TOTEMS_FILE = path.join(__dirname, "totems.json");
```

por:

```js
// TOTEMS_FILE lets tests (and deployments) keep the config elsewhere
const TOTEMS_FILE = process.env.TOTEMS_FILE || path.join(__dirname, "totems.json");
```

- [ ] **Step 2: Adicionar o script de teste**

Em `package.json`, dentro de `"scripts"`, adicione a linha `"test"` (mantenha as outras):

```json
    "test": "node --test \"tests/**/*.test.js\"",
```

- [ ] **Step 3: Criar o helper que sobe o servidor**

Crie `tests/helpers/server.js`:

```js
// Starts the real server.js on a random port with a temporary totems.json.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function startServer({ totems = {}, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audiosync-test-"));
  const totemsFile = path.join(dir, "totems.json");
  fs.writeFileSync(totemsFile, JSON.stringify(totems, null, 2));

  const port = 20000 + Math.floor(Math.random() * 20000);
  const proc = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      TOTEMS_FILE: totemsFile,
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
```

- [ ] **Step 4: Criar os helpers de WebSocket**

Crie `tests/helpers/ws.js`:

```js
const WebSocket = require("ws");

// Opens a socket and records every JSON message it receives.
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages = [];
    ws.on("message", raw => messages.push(JSON.parse(raw)));
    ws.once("error", reject);
    ws.once("open", () => {
      resolve({
        ws,
        messages,
        send: data => ws.send(JSON.stringify(data)),
        next: (type, timeout = 3000) => waitFor(ws, messages, type, timeout),
        received: type => messages.some(m => m.type === type),
        close: () => ws.close(),
      });
    });
  });
}

function waitFor(ws, messages, type, timeout) {
  const found = messages.find(m => m.type === type);
  if (found) return Promise.resolve(found);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error(`timeout waiting for "${type}"`));
    }, timeout);
    function onMessage(raw) {
      const msg = JSON.parse(raw);
      if (msg.type !== type) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(msg);
    }
    ws.on("message", onMessage);
  });
}

// Registers a totem screen like static/js/totem.js does.
async function registerScreen(wsBase, campaign, { instance, currentTime = 0, duration = 30 } = {}) {
  const query = instance ? `?instance=${encodeURIComponent(instance)}` : "";
  const screen = await connect(`${wsBase}/ws/screen/${campaign}${query}`);
  screen.send({ current_time: currentTime, duration, mode: "sync", drift_enabled: true });
  screen.session = await screen.next("session_created");
  return screen;
}

// Phone sync: the server sends one "sync" and closes. Resolves { code, sync }.
function mobileSync(wsBase, campaign, instance) {
  const query = instance ? `?instance=${encodeURIComponent(instance)}` : "";
  return new Promise(resolve => {
    const ws = new WebSocket(`${wsBase}/ws/mobile/${campaign}${query}`);
    let sync = null;
    ws.on("message", raw => {
      const msg = JSON.parse(raw);
      if (msg.type === "sync") sync = msg;
    });
    ws.on("close", code => resolve({ code, sync }));
    ws.on("error", () => {});
  });
}

module.exports = { connect, registerScreen, mobileSync };
```

- [ ] **Step 5: Escrever um teste de fumaça**

Crie `tests/smoke.integration.test.js`:

```js
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { startServer } = require("./helpers/server");

let server;
before(async () => { server = await startServer({ totems: { camp: { video: "v.mp4", audio: "a.mp3" } } }); });
after(() => server.stop());

test("server starts with the temporary totems file", async () => {
  const res = await fetch(`${server.base}/health`);
  assert.equal(res.status, 200);

  const cookie = await server.login();
  const totems = await (await fetch(`${server.base}/api/totems`, { headers: { Cookie: cookie } })).json();
  assert.deepEqual(totems.map(t => t.id), ["camp"]);
});

test("admin writes go to TOTEMS_FILE, not the project totems.json", async () => {
  const cookie = await server.login();
  const res = await fetch(`${server.base}/api/totems`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ id: "smoke_new" }),
  });
  assert.equal(res.status, 201);
  assert.ok(JSON.parse(fs.readFileSync(server.totemsFile, "utf8")).smoke_new);
});
```

- [ ] **Step 6: Rodar os testes**

Run: `npm test`
Expected: 2 testes `pass`, 0 `fail`. Confira com `git status` que o `totems.json` do projeto **não** mudou por causa do teste.

- [ ] **Step 7: Commit**

```bash
git add server.js package.json tests/
git commit -m "test: add node:test setup and configurable TOTEMS_FILE"
```

---

### Task 2: Registro de instâncias (`lib/instances.js`)

**Files:**
- Create: `lib/instances.js`
- Test: `tests/instances.test.js`

- [ ] **Step 1: Escrever os testes que falham**

Crie `tests/instances.test.js`:

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createInstanceRegistry, DEFAULT_INSTANCE } = require("../lib/instances");

// Fake clock in seconds, so tests control time
function setup(opts = {}) {
  let t = 1000;
  const clock = { now: () => t, advance: s => (t += s) };
  return { reg: createInstanceRegistry({ now: clock.now, graceSeconds: 60, ...opts }), clock };
}
const fakeWs = () => ({ id: Math.random() });

test("each instance of a campaign has its own session", () => {
  const { reg } = setup();
  const a = reg.register("camp", "a", fakeWs());
  const b = reg.register("camp", "b", fakeWs());
  reg.startSession(a, { current_time: 5, duration: 30, drift_enabled: true });
  reg.startSession(b, { current_time: 20, duration: 30 });

  assert.equal(reg.resolve("camp", "a").session.start_time, 995);
  assert.equal(reg.resolve("camp", "b").session.start_time, 980);
  assert.equal(reg.resolve("camp", "a").session.drift_enabled, true);
});

test("invalid or missing instance ids fall back to the default instance", () => {
  const { reg } = setup();
  assert.equal(reg.register("camp", undefined, fakeWs()).id, DEFAULT_INSTANCE);
  assert.equal(reg.register("camp", "bad id!", fakeWs()).id, DEFAULT_INSTANCE);
  assert.equal(reg.register("camp", "ok-ID_123", fakeWs()).id, "ok-ID_123");
});

test("resolve without instance returns the most recent online instance with a session", () => {
  const { reg } = setup();
  const a = reg.register("camp", "a", fakeWs());
  reg.startSession(a, { current_time: 0 });
  const b = reg.register("camp", "b", fakeWs());
  reg.startSession(b, { current_time: 0 });
  reg.register("camp", "c", fakeWs()); // no session yet

  assert.equal(reg.resolve("camp").id, "b");
  reg.disconnect(b, b.ws);
  assert.equal(reg.resolve("camp").id, "a");
});

test("resolve returns null for unknown campaign, unknown instance or no session", () => {
  const { reg } = setup();
  reg.register("camp", "a", fakeWs());
  assert.equal(reg.resolve("nope"), null);
  assert.equal(reg.resolve("camp", "zzz"), null);
  assert.equal(reg.resolve("camp", "a"), null);
});

test("updatePosition recalculates start_time from the server clock", () => {
  const { reg, clock } = setup();
  const a = reg.register("camp", "a", fakeWs());
  reg.startSession(a, { current_time: 0, duration: 30 });
  clock.advance(10);
  reg.updatePosition(a, 12);
  assert.equal(a.session.start_time, 998);
});

test("reconnecting with the same id reuses the instance and its phones", () => {
  const { reg } = setup();
  const ws1 = fakeWs();
  const a = reg.register("camp", "a", ws1);
  a.drifts.add("phone");
  reg.disconnect(a, ws1);
  const again = reg.register("camp", "a", fakeWs());
  assert.equal(again, a);
  assert.equal(again.disconnectedAt, null);
  assert.equal(again.drifts.size, 1);
});

test("disconnect from an old socket does not affect a newer one", () => {
  const { reg } = setup();
  const ws1 = fakeWs();
  const ws2 = fakeWs();
  const a = reg.register("camp", "a", ws1);
  reg.register("camp", "a", ws2);
  reg.disconnect(a, ws1);
  assert.equal(a.ws, ws2);
  assert.equal(reg.online("camp").length, 1);
});

test("online and stats count only connected screens; phones are summed", () => {
  const { reg } = setup();
  const a = reg.register("camp", "a", fakeWs());
  const b = reg.register("camp", "b", fakeWs());
  a.drifts.add("p1");
  a.drifts.add("p2");
  b.drifts.add("p3");
  reg.disconnect(b, b.ws);

  assert.deepEqual(reg.online("camp").map(i => i.id), ["a"]);
  assert.deepEqual(reg.stats("camp"), { instances: 1, mobiles: 3 });
  assert.deepEqual(reg.stats("nope"), { instances: 0, mobiles: 0 });
  assert.deepEqual(reg.campaignsOnline(), ["camp"]);
});

test("sweep removes instances disconnected longer than the grace period without phones", () => {
  const { reg, clock } = setup();
  const a = reg.register("camp", "a", fakeWs());
  const b = reg.register("camp", "b", fakeWs());
  b.drifts.add("phone");
  reg.disconnect(a, a.ws);
  reg.disconnect(b, b.ws);

  clock.advance(30);
  assert.equal(reg.sweep(), 0);
  clock.advance(31);
  assert.equal(reg.sweep(), 1);
  assert.equal(reg.get("camp", "a"), null);
  assert.ok(reg.get("camp", "b"));

  b.drifts.clear();
  assert.equal(reg.sweep(), 1);
  assert.deepEqual(reg.totals(), { instances: 0, online: 0, mobiles: 0 });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/instances.test.js`
Expected: FAIL com `Cannot find module '../lib/instances'`.

- [ ] **Step 3: Implementar o registro**

Crie `lib/instances.js`:

```js
/**
 * In-memory registry of playing screens ("instances"), grouped by campaign.
 *
 * Campaign = what the admin configures (video, audio, links); stored in
 * totems.json under the totem ID. Instance = one screen playing a campaign:
 * a physical totem or one visitor's iframe. Each instance has its own sync
 * session, so every phone follows the screen whose QR it scanned.
 */

const DEFAULT_INSTANCE = "default";
const INSTANCE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function createInstanceRegistry({ now = () => Date.now() / 1000, graceSeconds = 120 } = {}) {
  const campaigns = new Map(); // campaign → Map(instanceId → instance)
  let seq = 0;                 // registration order, to find the newest instance

  function bucket(campaign, create = false) {
    let b = campaigns.get(campaign);
    if (!b && create) {
      b = new Map();
      campaigns.set(campaign, b);
    }
    return b || null;
  }

  // A screen connected (or reconnected) its WebSocket
  function register(campaign, instanceId, ws) {
    const id = INSTANCE_ID_RE.test(instanceId || "") ? instanceId : DEFAULT_INSTANCE;
    const b = bucket(campaign, true);
    let inst = b.get(id);
    if (!inst) {
      inst = { campaign, id, ws: null, session: null, drifts: new Set(), seq: 0, disconnectedAt: null };
      b.set(id, inst);
    }
    inst.ws = ws;
    inst.seq = ++seq;
    inst.disconnectedAt = null;
    return inst;
  }

  // Screen reported its video position: the session timeline uses the SERVER clock
  function startSession(inst, { current_time, duration, mode, drift_enabled } = {}) {
    const t = now();
    inst.session = {
      start_time: t - (Number(current_time) || 0),
      duration: Number(duration) || 30,
      mode: mode || "sync",
      drift_enabled: !!drift_enabled,
      created_at: t,
    };
    return inst.session;
  }

  function updatePosition(inst, currentTime) {
    if (inst.session && Number.isFinite(currentTime)) inst.session.start_time = now() - currentTime;
  }

  function get(campaign, id) {
    const b = bucket(campaign);
    return (b && b.get(id)) || null;
  }

  // Instance a phone should follow: the one from its QR, or — for QR codes
  // without an instance (printed/legacy) — the newest online one with a session
  function resolve(campaign, instanceId) {
    if (instanceId) {
      const inst = get(campaign, instanceId);
      return inst && inst.session ? inst : null;
    }
    const b = bucket(campaign);
    if (!b) return null;
    let newest = null;
    for (const inst of b.values()) {
      if (!inst.session || inst.disconnectedAt !== null) continue;
      if (!newest || inst.seq > newest.seq) newest = inst;
    }
    return newest;
  }

  // Ignores stale sockets: a reconnect may already have replaced `ws`
  function disconnect(inst, ws) {
    if (inst.ws !== ws) return;
    inst.ws = null;
    inst.disconnectedAt = now();
  }

  function online(campaign) {
    const b = bucket(campaign);
    return b ? [...b.values()].filter(i => i.ws) : [];
  }

  function campaignsOnline() {
    return [...campaigns.keys()].filter(c => online(c).length > 0);
  }

  function stats(campaign) {
    const b = bucket(campaign);
    if (!b) return { instances: 0, mobiles: 0 };
    let mobiles = 0;
    for (const inst of b.values()) mobiles += inst.drifts.size;
    return { instances: online(campaign).length, mobiles };
  }

  // Drops screens closed for longer than the grace period. Instances with
  // phones still listening are kept so their drift correction keeps working.
  function sweep() {
    const t = now();
    let removed = 0;
    for (const [campaign, b] of campaigns) {
      for (const [id, inst] of b) {
        const expired = inst.disconnectedAt !== null && t - inst.disconnectedAt >= graceSeconds;
        if (expired && inst.drifts.size === 0) {
          b.delete(id);
          removed++;
        }
      }
      if (b.size === 0) campaigns.delete(campaign);
    }
    return removed;
  }

  function totals() {
    let instances = 0, onlineCount = 0, mobiles = 0;
    for (const b of campaigns.values()) {
      for (const inst of b.values()) {
        instances++;
        if (inst.ws) onlineCount++;
        mobiles += inst.drifts.size;
      }
    }
    return { instances, online: onlineCount, mobiles };
  }

  return { register, startSession, updatePosition, get, resolve, disconnect, online, campaignsOnline, stats, sweep, totals };
}

module.exports = { createInstanceRegistry, DEFAULT_INSTANCE, INSTANCE_ID_RE };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test tests/instances.test.js`
Expected: 9 testes `pass`, 0 `fail`.

- [ ] **Step 5: Commit**

```bash
git add lib/instances.js tests/instances.test.js
git commit -m "feat: add in-memory registry of screen instances per campaign"
```

---

### Task 3: Testes de integração das instâncias (falhando)

Escrevemos agora o comportamento esperado de ponta a ponta; as Tasks 4 e 5 fazem passar.

**Files:**
- Create: `tests/instances.integration.test.js`

- [ ] **Step 1: Escrever os testes**

Crie `tests/instances.integration.test.js`:

```js
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer, sleep } = require("./helpers/server");
const { connect, registerScreen, mobileSync } = require("./helpers/ws");

let server;
before(async () => {
  server = await startServer({ totems: { camp: { video: "camp_video.mp4", audio: "camp_audio.mp3" } } });
});
after(() => server.stop());

test("two screens of the same campaign keep separate sessions", async () => {
  const a = await registerScreen(server.wsBase, "camp", { instance: "inst-a", currentTime: 5 });
  const b = await registerScreen(server.wsBase, "camp", { instance: "inst-b", currentTime: 20 });
  try {
    assert.equal(a.session.instance, "inst-a");
    assert.equal(b.session.instance, "inst-b");

    const now = Date.now() / 1000;
    const syncA = (await mobileSync(server.wsBase, "camp", "inst-a")).sync;
    const syncB = (await mobileSync(server.wsBase, "camp", "inst-b")).sync;

    assert.equal(syncA.instance, "inst-a");
    assert.equal(syncB.instance, "inst-b");
    assert.ok(Math.abs(syncA.start_time - (now - 5)) < 1, "A keeps its own timeline");
    assert.ok(Math.abs(syncB.start_time - (now - 20)) < 1, "B keeps its own timeline");
    assert.equal(syncA.audio, "/media/camp_audio.mp3", "audio comes from the campaign");
  } finally {
    a.close();
    b.close();
  }
});

test("mobile_connected goes only to the scanned screen", async () => {
  const a = await registerScreen(server.wsBase, "camp", { instance: "notify-a" });
  const b = await registerScreen(server.wsBase, "camp", { instance: "notify-b" });
  try {
    await mobileSync(server.wsBase, "camp", "notify-a");
    await a.next("mobile_connected", 1500);
    await sleep(300);
    assert.equal(b.received("mobile_connected"), false);
  } finally {
    a.close();
    b.close();
  }
});

test("phone without instance (printed/legacy QR) follows the newest screen", async () => {
  const older = await registerScreen(server.wsBase, "camp", { instance: "legacy-old" });
  const newer = await registerScreen(server.wsBase, "camp", { instance: "legacy-new" });
  try {
    const { sync } = await mobileSync(server.wsBase, "camp");
    assert.equal(sync.instance, "legacy-new");
  } finally {
    older.close();
    newer.close();
  }
});

test("unknown instance or campaign closes the phone socket with 4004", async () => {
  assert.equal((await mobileSync(server.wsBase, "camp", "does-not-exist")).code, 4004);
  assert.equal((await mobileSync(server.wsBase, "nope")).code, 4004);
});

test("screen without instance parameter uses the default instance", async () => {
  const s = await registerScreen(server.wsBase, "camp");
  try {
    assert.equal(s.session.instance, "default");
  } finally {
    s.close();
  }
});

test("drift checks use the timeline of the phone's own screen", async () => {
  const a = await registerScreen(server.wsBase, "camp", { instance: "drift-a", currentTime: 3 });
  const b = await registerScreen(server.wsBase, "camp", { instance: "drift-b", currentTime: 17 });
  const drift = await connect(`${server.wsBase}/ws/drift/camp?instance=drift-b`);
  try {
    const check = await drift.next("drift_check", 3500);
    const syncA = (await mobileSync(server.wsBase, "camp", "drift-a")).sync;
    const syncB = (await mobileSync(server.wsBase, "camp", "drift-b")).sync;
    assert.equal(check.start_time, syncB.start_time, "drift follows drift-b");
    assert.notEqual(check.start_time, syncA.start_time, "not drift-a's timeline");
  } finally {
    drift.close();
    a.close();
    b.close();
  }
});

test("admin shows open screens and phones per campaign", async () => {
  const cookie = await server.login();
  const totems = async () =>
    (await (await fetch(`${server.base}/api/totems`, { headers: { Cookie: cookie } })).json()).find(t => t.id === "camp");

  const a = await registerScreen(server.wsBase, "camp", { instance: "admin-a" });
  const b = await registerScreen(server.wsBase, "camp", { instance: "admin-b" });
  const phone = await connect(`${server.wsBase}/ws/drift/camp?instance=admin-a`);
  try {
    await sleep(200);
    let t = await totems();
    assert.equal(t.is_online, true);
    assert.equal(t.instances, 2);
    assert.equal(t.mobile_count, 1);

    b.close();
    await sleep(300);
    t = await totems();
    assert.equal(t.instances, 1);
  } finally {
    phone.close();
    a.close();
  }
});

test("admin video change reaches every open screen of the campaign", async () => {
  const cookie = await server.login();
  const a = await registerScreen(server.wsBase, "camp", { instance: "bc-a" });
  const b = await registerScreen(server.wsBase, "camp", { instance: "bc-b" });
  try {
    // Registration already sends the current video; wait for it before clearing
    await a.next("change_video");
    await b.next("change_video");
    a.messages.length = 0;
    b.messages.length = 0;
    const res = await fetch(`${server.base}/api/totem/camp/config`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ video: "outro.mp4", audio: "camp_audio.mp3" }),
    });
    assert.equal(res.status, 200);
    assert.equal((await a.next("change_video")).filename, "outro.mp4");
    assert.equal((await b.next("change_video")).filename, "outro.mp4");
  } finally {
    a.close();
    b.close();
  }
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/instances.integration.test.js`
Expected: FAIL — por exemplo `session_created` sem `instance` (`undefined !== 'inst-a'`) e `sync` sem `instance`.

- [ ] **Step 3: Commit dos testes**

```bash
git add tests/instances.integration.test.js
git commit -m "test: add failing integration tests for per-instance sessions"
```

---

### Task 4: Servidor — WebSockets usando o registro

**Files:**
- Modify: `server.js` (imports no topo; mapas em memória perto da linha 70; seção `// ── WebSocket server` até `// ── Drift correction logic`)

- [ ] **Step 1: Importar o registro e trocar os mapas**

No topo do `server.js`, logo após `const { splitMedia, ... } = require("./lib/media-splitter");`, adicione:

```js
const { createInstanceRegistry } = require("./lib/instances");
```

Troque o bloco:

```js
const sessions = {};
const screenClients = {};   // { screenId: ws } — one totem per screen
const mobileClients = {};   // { screenId: Set<ws> }
const driftClients = {};    // { screenId: Set<ws> }
```

por:

```js
// Every screen playing a campaign (totem or iframe) is an instance with its own session
const instances = createInstanceRegistry();
// Forget screens that closed more than 2 minutes ago (and have no phones listening)
setInterval(() => instances.sweep(), 30000).unref();

// Sends a message to every open screen of a campaign; returns how many got it
function sendToCampaign(campaign, message) {
  const online = instances.online(campaign);
  online.forEach(inst => safeSend(inst.ws, message));
  return online.length;
}
```

> `sendToCampaign` usa `safeSend`, que é declarada mais abaixo como `function` — o hoisting de funções resolve.

- [ ] **Step 2: Passar o ID da instância no upgrade do WebSocket**

Na seção `// ── WS route matching`, troque o handler `server.on("upgrade", ...)` inteiro e o `wss.on("connection", ...)` por:

```js
server.on("upgrade", (req, socket, head) => {
  const parsed = url.parse(req.url, true);
  const match = parsed.pathname.match(/^\/ws\/(screen|mobile|drift)\/([^/]+)$/);
  if (!match) return socket.destroy();

  req._wsRoute = match[1];
  req._screenId = match[2];                         // campaign (totem ID)
  req._instanceId = String(parsed.query.instance || "");
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

// ── WS connection handler ───────────────────────────────────────────────────
wss.on("connection", (ws, req) => {
  const route = req._wsRoute;
  const campaign = req._screenId;
  const instanceId = req._instanceId;

  if (route === "screen") handleScreen(ws, campaign, instanceId);
  else if (route === "mobile") handleMobile(ws, campaign, instanceId);
  else if (route === "drift") handleDrift(ws, campaign, instanceId);
});
```

- [ ] **Step 3: Reescrever `handleScreen`**

Substitua a função `handleScreen` inteira por:

```js
// ── /ws/screen/:campaign?instance=ID — a screen playing the campaign ────────
// Stays open: receives change_video / change_screen / mobile_connected.
function handleScreen(ws, campaign, instanceId) {
  const inst = instances.register(campaign, instanceId, ws);
  console.log(`[Screen] ${campaign}/${inst.id} connected`);

  ws.on("message", (raw) => {
    try {
      const data = JSON.parse(raw);

      if (data.type === "position_update") {
        // Periodic position: recalculate start_time with the SERVER clock
        instances.updatePosition(inst, data.current_time);
        return;
      }

      // Registration: the screen sends its video.currentTime
      const session = instances.startSession(inst, data);
      console.log(`[Screen] Session ${campaign}/${inst.id} — ${session.duration}s (pos: ${(Number(data.current_time) || 0).toFixed(2)}s)`);
      safeSend(ws, { type: "session_created", screen_id: campaign, instance: inst.id });

      // Tell the screen which video to play
      if (totemsConf[campaign] && totemsConf[campaign].video) {
        safeSend(ws, { type: "change_video", filename: totemsConf[campaign].video });
      }
    } catch (err) {
      safeSend(ws, { type: "error", detail: err.message });
    }
  });

  // Heartbeat to keep connection alive
  const pingInterval = setInterval(() => {
    if (ws.readyState === 1) ws.ping();
    else clearInterval(pingInterval);
  }, 30000);

  ws.on("error", () => {});
  ws.on("close", () => {
    clearInterval(pingInterval);
    instances.disconnect(inst, ws);
    console.log(`[Screen] ${campaign}/${inst.id} disconnected`);
  });
}
```

> O log `position update` a cada 5s por tela foi removido de propósito: com muitos visitantes ele vira ruído.

- [ ] **Step 4: Reescrever `handleMobile`**

Substitua a função `handleMobile` inteira por:

```js
// ── /ws/mobile/:campaign?instance=ID — phone sync (fire-and-close) ──────────
function handleMobile(ws, campaign, instanceId) {
  const inst = instances.resolve(campaign, instanceId);
  if (!inst) {
    safeSend(ws, { type: "error", detail: "Session not found" });
    ws.close(4004, "Session not found");
    return;
  }

  const conf = totemsConf[campaign];
  const audio = conf && conf.audio ? `/media/${conf.audio}` : "/media/ivete_audio.mp3"; // fallback

  // Send sync payload — NEVER send current_position
  safeSend(ws, {
    type: "sync",
    instance: inst.id,               // phone uses it for the drift socket
    start_time: inst.session.start_time,
    duration: inst.session.duration,
    server_time: Date.now() / 1000,
    drift_enabled: inst.session.drift_enabled,
    audio,
    promo: promoFor(campaign),
  });

  // Only the scanned screen hides its QR
  if (inst.ws) safeSend(inst.ws, { type: "mobile_connected" });

  ws.close(1000, "Sync delivered");
  ws.on("error", () => {});
}
```

- [ ] **Step 5: Reescrever `handleDrift`**

Substitua a função `handleDrift` inteira por:

```js
// ── /ws/drift/:campaign?instance=ID — drift correction for one phone ───────
function handleDrift(ws, campaign, instanceId) {
  const inst = instances.resolve(campaign, instanceId);
  if (!inst) {
    safeSend(ws, { type: "error", detail: "Session not found" });
    ws.close(4004, "Session not found");
    return;
  }
  if (inst.drifts.size >= MAX_MOBILE_PER_SCREEN) {
    safeSend(ws, { type: "error", detail: "Too many drift connections" });
    ws.close(4029, "Too many connections");
    return;
  }

  inst.drifts.add(ws);

  const interval = setInterval(() => {
    const session = inst.session;
    if (!session || ws.readyState !== 1) {
      clearInterval(interval);
      return;
    }
    const now = Date.now() / 1000;
    const expectedPosition =
      ((now - session.start_time) % session.duration + session.duration) % session.duration;

    safeSend(ws, {
      type: "drift_check",
      expected_position: expectedPosition,
      server_time: now,
      start_time: session.start_time,
      duration: session.duration,
      threshold_ms: DRIFT_THRESHOLD_MS,
    });
  }, DRIFT_INTERVAL_MS);

  ws.on("message", (raw) => {
    try {
      const data = JSON.parse(raw);
      if (data.type === "position_report" && inst.session) {
        const correction = computeCorrection(data.position, inst.session.start_time, inst.session.duration);
        safeSend(ws, correction || { type: "drift_ok" });
      }
    } catch (_) {}
  });

  const cleanup = () => {
    clearInterval(interval);
    inst.drifts.delete(ws);
  };
  ws.on("error", cleanup);
  ws.on("close", cleanup);
}
```

- [ ] **Step 6: Verificar sintaxe**

Run: `node --check server.js`
Expected: nenhuma saída. (Ainda haverá referências a `screenClients`/`mobileClients`/`sessions` nas rotas HTTP — a Task 5 resolve; `node --check` não acusa isso, mas o servidor quebraria ao chamar essas rotas.)

- [ ] **Step 7: Commit**

```bash
git add server.js
git commit -m "feat(server): per-instance sessions for screen, mobile and drift sockets"
```

---

### Task 5: Servidor — broadcasts, admin e health usando o registro

**Files:**
- Modify: `server.js` (rotas de mídia/totens e `/health`)

- [ ] **Step 1: Encontrar todas as referências antigas**

Run: `grep -n "screenClients\|mobileClients\|driftClients\|sessions\[\|Object.keys(sessions)" server.js`
Expected: 11 linhas, nas rotas de renomear mídia, `GET /api/totems`, `POST /api/totem/:id/config`, `POST /api/totems`, `PATCH /api/totem/:id`, `DELETE /api/totem/:id` e `/health`.

- [ ] **Step 2: Renomear mídia (rota `app.patch("/api/media/:filename")`)**

Troque:

```js
      const ws = screenClients[id];
      if (ws) safeSend(ws, { type: "change_video", filename: newName });
```

por:

```js
      sendToCampaign(id, { type: "change_video", filename: newName });
```

- [ ] **Step 3: `GET /api/totems`**

Troque o corpo da rota `app.get("/api/totems", ...)` inteiro por:

```js
app.get("/api/totems", (req, res) => {
  // Saved campaigns + campaigns with open screens that were never saved
  const allIds = new Set([...Object.keys(totemsConf), ...instances.campaignsOnline()]);

  res.json([...allIds].map(id => {
    const { instances: openScreens, mobiles } = instances.stats(id);
    return {
      id,
      configured: !!totemsConf[id], // false = online but never saved in the admin
      is_online: openScreens > 0,
      instances: openScreens,       // screens/iframes playing right now
      mobile_count: mobiles,        // phones listening (drift sockets)
      video: totemsConf[id] ? totemsConf[id].video : null,
      audio: totemsConf[id] ? totemsConf[id].audio : null,
      promo: promoFor(id),
    };
  }));
});
```

> `mobile_count` antes contava só sockets de sync em trânsito (quase sempre 0). Agora conta os celulares realmente ouvindo.

- [ ] **Step 4: `POST /api/totem/:id/config`**

Troque:

```js
  // Broadcast video change immediately if totem is online
  const ws = screenClients[id];
  if (ws && ws.readyState === 1) {
    safeSend(ws, { type: "change_video", filename: video });
  }
```

por:

```js
  // Every open screen of this campaign switches video right away
  sendToCampaign(id, { type: "change_video", filename: video });
```

- [ ] **Step 5: `POST /api/totems` (criar)**

Troque:

```js
  // A totem already online under this ID picks up its video right away
  const ws = screenClients[id];
  if (ws && video) safeSend(ws, { type: "change_video", filename: video });
```

por:

```js
  // Screens already open under this ID pick up the video right away
  if (video) sendToCampaign(id, { type: "change_video", filename: video });
```

- [ ] **Step 6: `PATCH /api/totem/:id` (editar/renomear)**

Troque:

```js
  const ws = screenClients[oldId];
  if (ws) {
    if (newId !== oldId) {
      // The totem page reloads itself with ?screen=<newId>
      safeSend(ws, { type: "change_screen", screen: newId });
    } else if (videoChanged && conf.video) {
      safeSend(ws, { type: "change_video", filename: conf.video });
    }
  }
```

por:

```js
  if (newId !== oldId) {
    // Every open screen reloads itself with ?screen=<newId>
    sendToCampaign(oldId, { type: "change_screen", screen: newId });
  } else if (videoChanged && conf.video) {
    sendToCampaign(oldId, { type: "change_video", filename: conf.video });
  }
```

- [ ] **Step 7: `DELETE /api/totem/:id`**

Troque:

```js
  res.json({ success: true, id, still_online: !!screenClients[id] });
```

por:

```js
  res.json({ success: true, id, still_online: instances.online(id).length > 0 });
```

- [ ] **Step 8: `/health`**

Troque a rota `app.get("/health", ...)` inteira por:

```js
app.get("/health", (req, res) => {
  const t = instances.totals();
  res.json({
    status: "ok",
    server_time: Date.now() / 1000,
    sessions: t.instances,      // instances kept in memory (open + recently closed)
    screens_online: t.online,
    mobile_clients: t.mobiles,
    uptime_s: Math.round(process.uptime()),
  });
});
```

- [ ] **Step 9: Confirmar que não sobrou nada**

Run: `grep -n "screenClients\|mobileClients\|driftClients\|sessions\[\|Object.keys(sessions)" server.js`
Expected: nenhuma saída.

- [ ] **Step 10: Rodar toda a suíte**

Run: `npm test`
Expected: todos os testes `pass` (smoke, unitários e integração), 0 `fail`.

- [ ] **Step 11: Commit**

```bash
git add server.js
git commit -m "feat(server): broadcast to every instance and report instances in admin and health"
```

---

### Task 6: Página do totem gera e usa o ID da instância

**Files:**
- Modify: `static/js/totem.js` (bloco `// ── Config` no topo e `registerSession`)

- [ ] **Step 1: Gerar o ID e usar no QR**

No bloco `// ── Config` do `static/js/totem.js`, troque:

```js
const MOBILE_URL = `${location.protocol}//${location.host}/static/mobile.html?screen=${SCREEN_ID}`;
```

por:

```js
// One instance per page load: every screen/iframe gets its own sync session.
// (crypto.randomUUID only exists on https/localhost, hence the fallback.)
const INSTANCE_ID = (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const MOBILE_URL = `${location.protocol}//${location.host}/static/mobile.html` +
    `?screen=${encodeURIComponent(SCREEN_ID)}&instance=${INSTANCE_ID}`;
```

- [ ] **Step 2: Usar o ID no WebSocket**

Em `registerSession()`, troque:

```js
    const ws = new WebSocket(`${WS_PROTO}://${WS_HOST}/ws/screen/${SCREEN_ID}?api_key=${API_KEY}`);
```

por:

```js
    // Reconnects reuse INSTANCE_ID, so phones already synced keep their session
    const ws = new WebSocket(`${WS_PROTO}://${WS_HOST}/ws/screen/${SCREEN_ID}?instance=${INSTANCE_ID}&api_key=${API_KEY}`);
```

- [ ] **Step 3: Verificar sintaxe**

Run: `node -e "new Function(require('fs').readFileSync('static/js/totem.js','utf8'))"`
Expected: nenhuma saída.

- [ ] **Step 4: Commit**

```bash
git add static/js/totem.js
git commit -m "feat(totem): generate an instance id per page load for WS and QR"
```

---

### Task 7: Celular (normal e debug) usa a instância

**Files:**
- Modify: `static/js/mobile.js` (topo, `connectSync`, `startDriftConnection`)
- Modify: `static/js/mobile_debug.js` (mesmos pontos + selo)

- [ ] **Step 1: `mobile.js` — ler a instância da URL**

No bloco `// ── Config` do `static/js/mobile.js`, logo após `const SCREEN_ID = ...`, adicione:

```js
// Screen this phone follows (from the QR). Empty = legacy QR → server picks the newest screen.
const INSTANCE_ID = params.get("instance") || "";
const instanceQuery = id => (id ? `?instance=${encodeURIComponent(id)}` : "");
```

- [ ] **Step 2: `mobile.js` — sync e drift com a instância**

Em `connectSync()`, troque:

```js
    const ws = new WebSocket(`${WS_PROTO}://${WS_HOST}/ws/mobile/${SCREEN_ID}`);
```

por:

```js
    const ws = new WebSocket(`${WS_PROTO}://${WS_HOST}/ws/mobile/${SCREEN_ID}${instanceQuery(INSTANCE_ID)}`);
```

Em `startDriftConnection()`, troque:

```js
    driftWs = new WebSocket(`${WS_PROTO}://${WS_HOST}/ws/drift/${SCREEN_ID}`);
```

por:

```js
    // Use the instance the server actually synced us to (matters for legacy QRs)
    driftWs = new WebSocket(`${WS_PROTO}://${WS_HOST}/ws/drift/${SCREEN_ID}${instanceQuery(syncData.instance || INSTANCE_ID)}`);
```

- [ ] **Step 3: `mobile_debug.js` — mesmas mudanças**

No `static/js/mobile_debug.js`, logo após `const SCREEN_ID = ...`, adicione:

```js
const INSTANCE_ID = params.get("instance") || "";
const instanceQuery = id => (id ? `?instance=${encodeURIComponent(id)}` : "");
```

Troque:

```js
document.getElementById("screenBadge").textContent = SCREEN_ID.toUpperCase();
```

por:

```js
// Badge: campaign + first chars of the instance id
document.getElementById("screenBadge").textContent =
    SCREEN_ID.toUpperCase() + (INSTANCE_ID ? ` · ${INSTANCE_ID.slice(0, 8)}` : "");
```

Em `connectSync()`, troque:

```js
    const ws = new WebSocket(`${WS_PROTO}://${WS_HOST}/ws/mobile/${SCREEN_ID}`);
```

por:

```js
    const ws = new WebSocket(`${WS_PROTO}://${WS_HOST}/ws/mobile/${SCREEN_ID}${instanceQuery(INSTANCE_ID)}`);
```

Em `startDriftConnection()`, troque:

```js
    driftWs = new WebSocket(`${WS_PROTO}://${WS_HOST}/ws/drift/${SCREEN_ID}`);
```

por:

```js
    driftWs = new WebSocket(`${WS_PROTO}://${WS_HOST}/ws/drift/${SCREEN_ID}${instanceQuery(syncData.instance || INSTANCE_ID)}`);
```

- [ ] **Step 4: Verificar sintaxe**

Run: `for f in static/js/mobile.js static/js/mobile_debug.js; do node -e "new Function(require('fs').readFileSync('$f','utf8'))"; done`
Expected: nenhuma saída.

- [ ] **Step 5: Commit**

```bash
git add static/js/mobile.js static/js/mobile_debug.js
git commit -m "feat(mobile): sync and drift against the scanned screen instance"
```

---

### Task 8: Admin mostra telas abertas

**Files:**
- Modify: `static/js/admin.js` (template do card em `renderTotems` e `updateTotemStatus`)

- [ ] **Step 1: Adicionar a métrica no card**

Em `renderTotems`, no template do card, troque:

```js
                <div class="card-metrics">
                    <div class="metric">
                        <span class="metric-label">Celulares conectados</span>
                        <span class="metric-value mobile-count"></span>
                    </div>
                </div>
```

por:

```js
                <div class="card-metrics">
                    <div class="metric">
                        <span class="metric-label">Telas abertas</span>
                        <span class="metric-value instance-count"></span>
                    </div>
                    <div class="metric">
                        <span class="metric-label">Celulares ouvindo</span>
                        <span class="metric-value mobile-count"></span>
                    </div>
                </div>
```

- [ ] **Step 2: Atualizar o valor no polling**

Em `updateTotemStatus`, logo após a linha:

```js
        card.querySelector('.mobile-count').textContent = totem.mobile_count;
```

adicione:

```js
        card.querySelector('.instance-count').textContent = totem.instances;
```

- [ ] **Step 3: Verificar sintaxe**

Run: `node -e "new Function(require('fs').readFileSync('static/js/admin.js','utf8'))"`
Expected: nenhuma saída.

- [ ] **Step 4: Commit**

```bash
git add static/js/admin.js
git commit -m "feat(admin): show open screens and listening phones per campaign"
```

---

### Task 9: Verificação manual ponta a ponta

**Files:** nenhum no repositório (o tester de iframes fica fora do projeto).

- [ ] **Step 1: Suíte completa**

Run: `npm test`
Expected: todos `pass`, 0 `fail`.

- [ ] **Step 2: Subir o servidor**

Run: `npm run dev`
Expected: servidor em `http://0.0.0.0:8001`, sem erros.

- [ ] **Step 3: Várias telas da mesma campanha**

Abra `C:\Users\db\Documents\db\prj\dreambricks\iframe-tester\index.html`, campo "Totens" = `totem1`, adicione 3 tamanhos. Esperado:
- os 3 iframes tocam o vídeo;
- cada QR é diferente (o link termina com `&instance=<id próprio>`);
- no admin, o card do `totem1` mostra **Telas abertas: 3**.

- [ ] **Step 4: Celular segue a tela certa**

Recarregue só um dos iframes (botão ↻) para ele ficar em outro ponto do vídeo. Escaneie o QR **desse** iframe com o celular. Esperado:
- o áudio no celular bate com **esse** iframe, não com os outros;
- só esse iframe esconde o QR (`mobile_connected`);
- no admin: **Celulares ouvindo: 1**.

- [ ] **Step 5: Compatibilidade**

Abra no celular `http://<servidor>/static/mobile.html?screen=totem1` (sem `instance`). Esperado: sincroniza com a tela aberta mais recentemente.

- [ ] **Step 6: Atualizar a dica do tester (fora do repositório, sem commit)**

Em `C:\Users\db\Documents\db\prj\dreambricks\iframe-tester\index.html`, troque o texto do `<p class="hint">` por:

```html
            O totem precisa estar cadastrado e com vídeo no admin. Cada quadro é uma <strong>instância</strong> própria,
            com sincronia e QR próprios — dá para abrir vários quadros da mesma campanha. URL gerada:
            <code>/static/totem.html?screen=ID&amp;showqr=…&amp;fit=…</code>
```

- [ ] **Step 7: Push da branch (só com autorização do usuário)**

```bash
git push -u origin feat/campaign-instances
```

---

## Fora do escopo desta parte (vai para a Parte 2)

- Limites por IP e por campanha contra abuso.
- Botão "Ouvir neste aparelho" para quem vê o site no próprio celular.
- Código de incorporação (iframe) gerado pelo admin.
- Mídia servida por CDN (`MEDIA_BASE_URL`) e versão de vídeo leve para web.
- Script de teste de carga e guia de produção.
