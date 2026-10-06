# Campanhas e Instâncias — Parte 2 (Melhorias) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deixar o modelo de campanhas/instâncias pronto para sites públicos: proteção contra abuso, áudio direto no aparelho para quem vê o site no celular, código de incorporação gerado no admin, mídia por CDN, vídeo leve para web, teste de carga e guia de produção.

**Architecture:** Tudo se apoia no registro de instâncias da Parte 1 (`lib/instances.js`, `instances` e `sendToCampaign` no `server.js`). Lógica nova e testável vai para módulos pequenos: `lib/media-url.js` (servidor) e `static/js/local-audio.js` / `static/js/embed-code.js` (navegador, exportados também para `node:test`). O resto são ajustes pontuais no `server.js`, `totem.js`, admin e separador de mídia.

**Tech Stack:** Node.js 22, Express 4, `ws` 8, `node:test`, ffmpeg (já usado pelo separador).

**Pré-requisito:** Parte 1 concluída na branch `feat/campaign-instances` com `npm test` passando.

**Commits:** sem trailer `Co-Authored-By` (preferência do usuário).

---

## Mapa de arquivos

| Arquivo | Ação | Responsabilidade |
|---|---|---|
| `server.js` | Modificar | Limites por IP/campanha; `videoMessage()` com áudio; `MEDIA_BASE_URL`; split com `web=1`; memória no `/health` |
| `lib/media-url.js` | Criar | Monta a URL pública de um arquivo de mídia (local ou CDN) |
| `lib/media-splitter.js` | Modificar | Opção `web` (vídeo H.264 leve) |
| `scripts/split-media.js` | Modificar | Flag `--web` |
| `scripts/load-test.js` | Criar | Simula N telas e M celulares por tela |
| `static/js/local-audio.js` | Criar | Cálculo de desvio áudio × vídeo (usado pelo "Ouvir aqui") |
| `static/js/embed-code.js` | Criar | Gera URL e código `<iframe>` de incorporação |
| `static/totem.html`, `static/css/totem.css`, `static/js/totem.js` | Modificar | Botão "Ouvir aqui"; respeitar limite (4029); URL de mídia absoluta |
| `static/admin.html`, `static/css/admin.css`, `static/js/admin.js` | Modificar | Modal "Incorporar"; opção "Otimizar para sites" no separador |
| `tests/limits.integration.test.js` | Criar | Limites por IP e por campanha |
| `tests/video-message.integration.test.js` | Criar | `change_video` leva o áudio; `MEDIA_BASE_URL` |
| `tests/local-audio.test.js`, `tests/embed-code.test.js`, `tests/media-url.test.js` | Criar | Unitários |
| `tests/media-splitter.test.js` | Criar | Opção `web` (pula se não houver ffmpeg) |
| `.env-example` | Modificar | Novas variáveis |
| `docs/incorporacao-e-producao.md` | Criar | Guia de incorporação e checklist de produção |

---

### Task 1: Limites de telas por IP e por campanha

Sem limite, qualquer um pode abrir milhares de "telas" falsas. Atrás de proxy/túnel (ngrok, Nginx, Cloudflare) o IP real vem em `X-Forwarded-For`; só confiamos nele com `TRUST_PROXY=1`. Sem isso, conexões vindas de loopback (o próprio túnel local) não são limitadas por IP — senão todos os visitantes contariam como um só.

**Files:**
- Modify: `server.js` (config no topo; `server.on("upgrade")`; `wss.on("connection")`; `handleScreen`)
- Modify: `static/js/totem.js` (`ws.onclose` em `registerSession`)
- Modify: `.env-example`
- Test: `tests/limits.integration.test.js`

- [ ] **Step 1: Escrever os testes que falham**

Crie `tests/limits.integration.test.js`:

```js
const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");
const { startServer } = require("./helpers/server");

// Opens a screen socket pretending to come from `ip` (via X-Forwarded-For).
// Resolves "ok" once the session is created, or the close code if rejected.
function openScreen(wsBase, campaign, instance, ip) {
  return new Promise(resolve => {
    const ws = new WebSocket(`${wsBase}/ws/screen/${campaign}?instance=${instance}`, {
      headers: { "X-Forwarded-For": ip },
    });
    ws.on("open", () => ws.send(JSON.stringify({ current_time: 0, duration: 30, drift_enabled: true })));
    ws.on("message", raw => {
      if (JSON.parse(raw).type === "session_created") resolve({ result: "ok", ws });
    });
    ws.on("close", code => resolve({ result: code, ws }));
    ws.on("error", () => {});
  });
}

describe("per-IP limit", () => {
  let server;
  before(async () => {
    server = await startServer({
      totems: { camp: { video: "v.mp4", audio: "a.mp3" } },
      env: { TRUST_PROXY: "1", MAX_SCREENS_PER_IP: "2", MAX_INSTANCES_PER_CAMPAIGN: "100" },
    });
  });
  after(() => server.stop());

  test("a third screen from the same IP is rejected with 4029", async () => {
    const a = await openScreen(server.wsBase, "camp", "ip-a", "10.0.0.1");
    const b = await openScreen(server.wsBase, "camp", "ip-b", "10.0.0.1");
    const c = await openScreen(server.wsBase, "camp", "ip-c", "10.0.0.1");
    const other = await openScreen(server.wsBase, "camp", "ip-d", "10.0.0.2");
    try {
      assert.equal(a.result, "ok");
      assert.equal(b.result, "ok");
      assert.equal(c.result, 4029);
      assert.equal(other.result, "ok", "other IPs are not affected");
    } finally {
      [a, b, c, other].forEach(s => s.ws.close());
    }
  });

  test("closing a screen frees a slot for that IP", async () => {
    const a = await openScreen(server.wsBase, "camp", "free-a", "10.0.0.9");
    const b = await openScreen(server.wsBase, "camp", "free-b", "10.0.0.9");
    b.ws.close();
    await new Promise(r => setTimeout(r, 200));
    const c = await openScreen(server.wsBase, "camp", "free-c", "10.0.0.9");
    try {
      assert.equal(c.result, "ok");
    } finally {
      a.ws.close();
      c.ws.close();
    }
  });
});

describe("per-campaign limit", () => {
  let server;
  before(async () => {
    server = await startServer({
      totems: { camp: { video: "v.mp4", audio: "a.mp3" } },
      env: { TRUST_PROXY: "1", MAX_SCREENS_PER_IP: "100", MAX_INSTANCES_PER_CAMPAIGN: "2" },
    });
  });
  after(() => server.stop());

  test("a campaign accepts at most N open screens, but a known instance can reconnect", async () => {
    const a = await openScreen(server.wsBase, "camp", "c-a", "10.1.0.1");
    const b = await openScreen(server.wsBase, "camp", "c-b", "10.1.0.2");
    const c = await openScreen(server.wsBase, "camp", "c-c", "10.1.0.3");
    const again = await openScreen(server.wsBase, "camp", "c-a", "10.1.0.1"); // same instance id
    try {
      assert.equal(a.result, "ok");
      assert.equal(b.result, "ok");
      assert.equal(c.result, 4029);
      assert.equal(again.result, "ok");
    } finally {
      [a, b, c, again].forEach(s => s.ws.close());
    }
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/limits.integration.test.js`
Expected: FAIL — `c.result` é `"ok"` em vez de `4029`.

- [ ] **Step 3: Configuração**

No `server.js`, logo após `const MAX_MOBILE_PER_SCREEN = 50;`, adicione:

```js
// Abuse protection for public embeds
const MAX_SCREENS_PER_IP = parseInt(process.env.MAX_SCREENS_PER_IP, 10) || 20;
const MAX_INSTANCES_PER_CAMPAIGN = parseInt(process.env.MAX_INSTANCES_PER_CAMPAIGN, 10) || 2000;
// Behind a proxy/tunnel (ngrok, Nginx, Cloudflare) set TRUST_PROXY=1 to use X-Forwarded-For
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
```

- [ ] **Step 4: Descobrir o IP do cliente no upgrade**

Logo antes de `server.on("upgrade", ...)`, adicione:

```js
const screensPerIp = new Map(); // ip → open screen sockets

function clientIp(req) {
  if (TRUST_PROXY && req.headers["x-forwarded-for"]) {
    return String(req.headers["x-forwarded-for"]).split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

// Without TRUST_PROXY, everything behind a local tunnel looks like loopback:
// we can't tell visitors apart, so the per-IP limit doesn't apply to it
function isLoopback(ip) {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}
```

Dentro do `server.on("upgrade", ...)`, logo após `req._instanceId = ...`, adicione:

```js
  req._ip = clientIp(req);
```

No `wss.on("connection", ...)`, troque:

```js
  if (route === "screen") handleScreen(ws, campaign, instanceId);
```

por:

```js
  if (route === "screen") handleScreen(ws, campaign, instanceId, req._ip);
```

- [ ] **Step 5: Aplicar os limites em `handleScreen`**

Troque o início de `handleScreen`:

```js
function handleScreen(ws, campaign, instanceId) {
  const inst = instances.register(campaign, instanceId, ws);
```

por:

```js
function handleScreen(ws, campaign, instanceId, ip) {
  const reconnecting = !!instances.get(campaign, instanceId);
  if (!reconnecting && instances.online(campaign).length >= MAX_INSTANCES_PER_CAMPAIGN) {
    ws.close(4029, "Campaign screen limit");
    return;
  }
  const limitIp = TRUST_PROXY || !isLoopback(ip);
  if (limitIp && (screensPerIp.get(ip) || 0) >= MAX_SCREENS_PER_IP) {
    ws.close(4029, "Too many screens from this address");
    return;
  }
  screensPerIp.set(ip, (screensPerIp.get(ip) || 0) + 1);

  const inst = instances.register(campaign, instanceId, ws);
```

E no `ws.on("close", ...)` do `handleScreen`, troque:

```js
  ws.on("close", () => {
    clearInterval(pingInterval);
    instances.disconnect(inst, ws);
```

por:

```js
  ws.on("close", () => {
    clearInterval(pingInterval);
    instances.disconnect(inst, ws);
    const left = (screensPerIp.get(ip) || 1) - 1;
    if (left > 0) screensPerIp.set(ip, left);
    else screensPerIp.delete(ip);
```

- [ ] **Step 6: Rodar e ver passar**

Run: `node --test tests/limits.integration.test.js`
Expected: 3 testes `pass`.

- [ ] **Step 7: O totem não deve insistir quando for barrado**

Em `static/js/totem.js`, em `registerSession()`, troque:

```js
    ws.onclose = () => {
        console.log("[Totem] WS closed — reconnecting in 3s");
        clearInterval(posInterval);
        registered = false;
        screenWs = null;
        setTimeout(registerSession, 3000);
    };
```

por:

```js
    ws.onclose = (e) => {
        // 4029 = screen limit reached: back off instead of hammering the server
        const delay = e.code === 4029 ? 60000 : 3000;
        console.log(`[Totem] WS closed (${e.code}) — reconnecting in ${delay / 1000}s`);
        clearInterval(posInterval);
        registered = false;
        screenWs = null;
        setTimeout(registerSession, delay);
    };
```

- [ ] **Step 8: Documentar as variáveis**

No fim do `.env-example`, adicione:

```
# Proteção para sites públicos
# Máximo de telas abertas por IP e por campanha
MAX_SCREENS_PER_IP=20
MAX_INSTANCES_PER_CAMPAIGN=2000
# Use 1 quando o servidor estiver atrás de proxy/túnel (ngrok, Nginx, Cloudflare)
TRUST_PROXY=0
```

- [ ] **Step 9: Suíte completa e commit**

Run: `npm test`
Expected: todos `pass`.

```bash
git add server.js static/js/totem.js .env-example tests/limits.integration.test.js
git commit -m "feat(server): limit open screens per IP and per campaign"
```

---

### Task 2: `change_video` passa a levar o áudio da campanha

Pré-requisito do "Ouvir aqui": a tela precisa saber qual é o áudio.

**Files:**
- Modify: `server.js` (`handleScreen`, renomear mídia, `POST /api/totem/:id/config`, `POST /api/totems`, `PATCH /api/totem/:id`)
- Test: `tests/video-message.integration.test.js`

- [ ] **Step 1: Escrever o teste que falha**

Crie `tests/video-message.integration.test.js`:

```js
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers/server");
const { registerScreen } = require("./helpers/ws");

let server;
before(async () => {
  server = await startServer({ totems: { camp: { video: "camp_video.mp4", audio: "camp_audio.mp3" } } });
});
after(() => server.stop());

test("change_video on registration includes the campaign audio", async () => {
  const s = await registerScreen(server.wsBase, "camp", { instance: "vm-a" });
  try {
    const msg = await s.next("change_video");
    assert.equal(msg.filename, "camp_video.mp4");
    assert.equal(msg.audio, "/media/camp_audio.mp3");
  } finally {
    s.close();
  }
});

test("changing only the audio in the admin notifies open screens", async () => {
  const cookie = await server.login();
  const s = await registerScreen(server.wsBase, "camp", { instance: "vm-b" });
  try {
    await s.next("change_video");
    s.messages.length = 0;
    const res = await fetch(`${server.base}/api/totem/camp/config`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ video: "camp_video.mp4", audio: "novo_audio.mp3" }),
    });
    assert.equal(res.status, 200);
    const msg = await s.next("change_video");
    assert.equal(msg.audio, "/media/novo_audio.mp3");
  } finally {
    s.close();
  }
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/video-message.integration.test.js`
Expected: FAIL — `msg.audio` é `undefined`.

- [ ] **Step 3: Criar o helper `videoMessage`**

No `server.js`, logo abaixo da função `sendToCampaign` (criada na Parte 1), adicione:

```js
// What a screen needs to play a campaign: the video, plus the audio for "Ouvir aqui"
function videoMessage(campaign) {
  const conf = totemsConf[campaign] || {};
  return {
    type: "change_video",
    filename: conf.video || "",
    audio: conf.audio ? `/media/${conf.audio}` : null,
  };
}
```

- [ ] **Step 4: Usar em todos os envios de `change_video`**

Em `handleScreen`, troque:

```js
        safeSend(ws, { type: "change_video", filename: totemsConf[campaign].video });
```

por:

```js
        safeSend(ws, videoMessage(campaign));
```

Na rota de renomear mídia (`app.patch("/api/media/:filename")`), troque o bloco:

```js
  updated.forEach(id => {
    if (totemsConf[id].video === oldName) {
      totemsConf[id].video = newName;
      sendToCampaign(id, { type: "change_video", filename: newName });
    }
    if (totemsConf[id].audio === oldName) totemsConf[id].audio = newName;
  });
  if (updated.length) saveTotemsConf(totemsConf);
```

por:

```js
  updated.forEach(id => {
    if (totemsConf[id].video === oldName) totemsConf[id].video = newName;
    if (totemsConf[id].audio === oldName) totemsConf[id].audio = newName;
  });
  if (updated.length) saveTotemsConf(totemsConf);
  // After the config is updated, so the message carries the new names
  updated.forEach(id => sendToCampaign(id, videoMessage(id)));
```

Em `POST /api/totem/:id/config`, troque:

```js
  sendToCampaign(id, { type: "change_video", filename: video });
```

por:

```js
  sendToCampaign(id, videoMessage(id));
```

Em `POST /api/totems`, troque:

```js
  if (video) sendToCampaign(id, { type: "change_video", filename: video });
```

por:

```js
  if (video) sendToCampaign(id, videoMessage(id));
```

Em `PATCH /api/totem/:id`, troque:

```js
  const videoChanged = conf.video !== totemsConf[oldId].video;
```

por:

```js
  const mediaChanged = conf.video !== totemsConf[oldId].video || conf.audio !== totemsConf[oldId].audio;
```

e troque:

```js
  } else if (videoChanged && conf.video) {
    sendToCampaign(oldId, { type: "change_video", filename: conf.video });
  }
```

por:

```js
  } else if (mediaChanged && conf.video) {
    sendToCampaign(oldId, videoMessage(oldId));
  }
```

- [ ] **Step 5: Conferir que não sobrou `change_video` literal**

Run: `grep -n "type: \"change_video\"" server.js`
Expected: só 1 ocorrência, dentro de `videoMessage`.

- [ ] **Step 6: Rodar e commit**

Run: `npm test`
Expected: todos `pass`.

```bash
git add server.js tests/video-message.integration.test.js
git commit -m "feat(server): include the campaign audio in change_video messages"
```

---

### Task 3: Botão "Ouvir aqui" para quem vê o site no celular

Quem está no celular não consegue escanear a própria tela. Nesse caso a página do totem mostra **"Ouvir aqui"** no lugar do QR e toca o áudio da campanha no próprio aparelho, sincronizado com o vídeo localmente (sem servidor). Parâmetro `?listen=auto|on|off` (padrão `auto`: liga em tela de toque com até 820px de largura — um totem físico de 1080px continua mostrando o QR).

**Files:**
- Create: `static/js/local-audio.js`
- Test: `tests/local-audio.test.js`
- Modify: `static/totem.html`, `static/css/totem.css`, `static/js/totem.js`

- [ ] **Step 1: Escrever o teste que falha**

Crie `tests/local-audio.test.js`:

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { driftSeconds, shouldResync } = require("../static/js/local-audio");

test("drift is audio minus video", () => {
  assert.equal(driftSeconds(10.5, 10, 30), 0.5);
  assert.equal(driftSeconds(9.75, 10, 30), -0.25);
});

test("drift wraps around the loop point", () => {
  // video just looped to 0.1s, audio still at 29.9s → audio is 0.2s behind
  assert.ok(Math.abs(driftSeconds(29.9, 0.1, 30) - -0.2) < 1e-9);
  assert.ok(Math.abs(driftSeconds(0.1, 29.9, 30) - 0.2) < 1e-9);
});

test("resync only above the threshold", () => {
  assert.equal(shouldResync(10.1, 10, 30), false);
  assert.equal(shouldResync(10.3, 10, 30), true);
  assert.equal(shouldResync(10.3, 10, 30, 0.5), false);
});

test("unknown duration still compares directly", () => {
  assert.equal(driftSeconds(5, 2, 0), 3);
  assert.equal(shouldResync(5, 2, NaN), true);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/local-audio.test.js`
Expected: FAIL com `Cannot find module '../static/js/local-audio'`.

- [ ] **Step 3: Implementar o helper**

Crie `static/js/local-audio.js`:

```js
// Audio ↔ video drift for "Ouvir aqui" (audio played on the same device as the
// video). Works in the browser (window.LocalAudio) and in node:test.
(function (root) {
    // Signed audio − video difference in seconds, wrap-aware for looping videos
    function driftSeconds(audioTime, videoTime, duration) {
        let d = audioTime - videoTime;
        if (duration > 0 && Math.abs(d) > duration / 2) d = d > 0 ? d - duration : d + duration;
        return d;
    }

    function shouldResync(audioTime, videoTime, duration, threshold = 0.2) {
        return Math.abs(driftSeconds(audioTime, videoTime, duration)) > threshold;
    }

    const api = { driftSeconds, shouldResync };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    else root.LocalAudio = api;
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test tests/local-audio.test.js`
Expected: 4 testes `pass`.

- [ ] **Step 5: Botão na página do totem**

Em `static/totem.html`, logo **depois** do `</div>` que fecha `<div class="qr-overlay">` (e ainda dentro de `.totem-container`), adicione:

```html
        <!-- "Ouvir aqui": visitor on a phone plays the audio on this device -->
        <button class="listen-btn" id="listenBtn" type="button" hidden>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>
            </svg>
            <span>Ouvir aqui</span>
        </button>
```

E troque:

```html
    <!-- Application script -->
    <script src="/static/js/totem.js"></script>
```

por:

```html
    <!-- Application scripts -->
    <script src="/static/js/local-audio.js"></script>
    <script src="/static/js/totem.js"></script>
```

- [ ] **Step 6: Estilo do botão**

No fim de `static/css/totem.css`, adicione:

```css
/* ── "Ouvir aqui" (listen on this device) ───────────── */
.listen-btn {
    position: absolute;
    bottom: var(--qr-bottom);
    left: 50%;
    transform: translateX(-50%);
    z-index: 11;
    display: inline-flex;
    align-items: center;
    gap: 0.5em;
    padding: 0.8em 1.4em;
    border: 0;
    border-radius: var(--radius-pill);
    background: var(--db-blue-500);
    color: var(--text-on-brand);
    font-family: var(--font-body);
    font-size: clamp(14px, 4.2vmin, 22px);
    font-weight: var(--weight-semibold);
    box-shadow: var(--shadow-lg);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
}
.listen-btn svg { width: 1.2em; height: 1.2em; }
.listen-btn.active { background: var(--db-blue-900); }
.listen-btn[hidden] { display: none; }

/* In listen mode the QR card is not shown */
.listen-mode .qr-overlay { display: none; }
```

- [ ] **Step 7: Lógica no `totem.js`**

Em `static/js/totem.js`, no fim do bloco `// ── Config` (depois da linha que trata `?fit=contain`), adicione:

```js
// ?listen=auto|on|off — "Ouvir aqui" instead of the QR. auto = touch screen up
// to 820px wide (a visitor's phone); a 1080px physical totem keeps the QR.
const LISTEN_PARAM = (urlParams.get('listen') || 'auto').toLowerCase();
const LISTEN_MODE = LISTEN_PARAM === 'on' ||
    (LISTEN_PARAM === 'auto' && matchMedia('(pointer: coarse)').matches && matchMedia('(max-width: 820px)').matches);
if (LISTEN_MODE) document.querySelector(".totem-container").classList.add("listen-mode");
```

Logo antes de `// ── Register session (WS stays open for notifications) ─`, adicione:

```js
// ── "Ouvir aqui": play the campaign audio on this device ───
const listenBtn  = document.getElementById("listenBtn");
const localAudio = new Audio();
localAudio.preload = "auto";
let audioUrl  = null;
let listening = false;
let audioSyncTimer = null;

function setAudioUrl(url) {
    const changed = (url || null) !== audioUrl;
    audioUrl = url || null;
    listenBtn.hidden = !(LISTEN_MODE && audioUrl);
    if (changed && listening) stopListening();
}

function updateListenBtn() {
    listenBtn.querySelector("span").textContent = listening ? "Parar áudio" : "Ouvir aqui";
    listenBtn.classList.toggle("active", listening);
}

async function startListening() {
    if (!audioUrl) return;
    if (localAudio.getAttribute("src") !== audioUrl) localAudio.src = audioUrl;
    try {
        await localAudio.play(); // runs inside the tap, so the browser allows it
    } catch (err) {
        console.error("[Totem] Local audio failed", err);
        return;
    }
    localAudio.currentTime = video.currentTime;
    listening = true;
    updateListenBtn();
    // Keep the audio on the video's timeline (loops, stalls, seeks)
    audioSyncTimer = setInterval(() => {
        if (LocalAudio.shouldResync(localAudio.currentTime, video.currentTime, video.duration || 0)) {
            localAudio.currentTime = video.currentTime;
        }
    }, 1000);
}

function stopListening() {
    listening = false;
    localAudio.pause();
    clearInterval(audioSyncTimer);
    updateListenBtn();
}

listenBtn.addEventListener("click", () => (listening ? stopListening() : startListening()));
```

Em `registerSession()`, no `ws.onmessage`, troque o ramo `change_video`:

```js
            } else if (data.type === "change_video") {
                // Prevent infinite loop by checking if we are already playing this video
                if (!video.src.includes(data.filename)) {
```

por:

```js
            } else if (data.type === "change_video") {
                setAudioUrl(data.audio);
                // Prevent infinite loop by checking if we are already playing this video
                if (!video.src.includes(data.filename)) {
```

- [ ] **Step 8: Verificar sintaxe e suíte**

Run: `node -e "new Function(require('fs').readFileSync('static/js/totem.js','utf8'))" && npm test`
Expected: sem erro de sintaxe; todos `pass`.

- [ ] **Step 9: Teste manual**

Com `npm run dev`, abra no celular `http://<servidor>/static/totem.html?screen=totem1`. Esperado: no lugar do QR aparece **Ouvir aqui**; ao tocar, o áudio toca junto com o vídeo; tocar de novo para. No computador, `?listen=on` força o botão; `?listen=off` força o QR.

- [ ] **Step 10: Commit**

```bash
git add static/js/local-audio.js tests/local-audio.test.js static/totem.html static/css/totem.css static/js/totem.js
git commit -m "feat(totem): 'Ouvir aqui' plays the campaign audio on the visitor's own device"
```

---

### Task 4: Código de incorporação no admin

**Files:**
- Create: `static/js/embed-code.js`
- Test: `tests/embed-code.test.js`
- Modify: `static/admin.html`, `static/css/admin.css`, `static/js/admin.js`

- [ ] **Step 1: Escrever o teste que falha**

Crie `tests/embed-code.test.js`:

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildEmbedUrl, buildEmbedCode } = require("../static/js/embed-code");

const base = { origin: "https://audio.exemplo.com/", campaign: "camp_1", width: 360, height: 640 };

test("URL has the campaign and only non-default options", () => {
  assert.equal(buildEmbedUrl(base), "https://audio.exemplo.com/static/totem.html?screen=camp_1");
  assert.equal(
    buildEmbedUrl({ ...base, fit: "contain", showQr: false, listen: "off" }),
    "https://audio.exemplo.com/static/totem.html?screen=camp_1&fit=contain&showqr=false&listen=off",
  );
});

test("fixed-size code uses width/height attributes", () => {
  const code = buildEmbedCode(base);
  assert.match(code, /^<iframe src="https:\/\/audio\.exemplo\.com\/static\/totem\.html\?screen=camp_1"/);
  assert.match(code, /width="360" height="640"/);
  assert.match(code, /allow="autoplay; fullscreen"/);
});

test("responsive code keeps the aspect ratio in a wrapper", () => {
  const code = buildEmbedCode({ ...base, responsive: true });
  assert.match(code, /aspect-ratio:360 \/ 640/);
  assert.match(code, /position:absolute;inset:0;width:100%;height:100%/);
});

test("ampersands in the URL are escaped in the HTML", () => {
  const code = buildEmbedCode({ ...base, fit: "contain" });
  assert.match(code, /screen=camp_1&amp;fit=contain/);
});

test("sizes are clamped to sane integers", () => {
  const code = buildEmbedCode({ ...base, width: "abc", height: 99999 });
  assert.match(code, /width="360" height="4000"/);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/embed-code.test.js`
Expected: FAIL com `Cannot find module '../static/js/embed-code'`.

- [ ] **Step 3: Implementar**

Crie `static/js/embed-code.js`:

```js
// Builds the totem URL and <iframe> snippet for embedding a campaign in a site.
// Works in the browser (window.EmbedCode) and in node:test.
(function (root) {
    function clampSize(value, fallback) {
        const n = parseInt(value, 10);
        if (!Number.isFinite(n)) return fallback;
        return Math.min(4000, Math.max(50, n));
    }

    function escapeAttr(s) {
        return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    }

    // Only non-default options go into the URL
    function buildEmbedUrl({ origin, campaign, fit, showQr, listen }) {
        const params = new URLSearchParams({ screen: campaign });
        if (fit === "contain") params.set("fit", "contain");
        if (showQr === false) params.set("showqr", "false");
        if (listen === "on" || listen === "off") params.set("listen", listen);
        return `${String(origin).replace(/\/+$/, "")}/static/totem.html?${params}`;
    }

    function buildEmbedCode(opts) {
        const width = clampSize(opts.width, 360);
        const height = clampSize(opts.height, 640);
        const src = escapeAttr(buildEmbedUrl(opts));
        const title = escapeAttr(opts.title || "Vídeo com áudio sincronizado");
        const common = `allow="autoplay; fullscreen" loading="lazy" title="${title}"`;

        if (opts.responsive) {
            return `<div style="position:relative;width:100%;aspect-ratio:${width} / ${height};">\n` +
                `  <iframe src="${src}" style="position:absolute;inset:0;width:100%;height:100%;border:0;" ${common}></iframe>\n` +
                `</div>`;
        }
        return `<iframe src="${src}" width="${width}" height="${height}" style="border:0;" ${common}></iframe>`;
    }

    const api = { buildEmbedUrl, buildEmbedCode };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    else root.EmbedCode = api;
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test tests/embed-code.test.js`
Expected: 5 testes `pass`.

- [ ] **Step 5: Modal no `admin.html`**

Em `static/admin.html`, logo antes de `<!-- Mobile page links editor -->`, adicione:

```html
    <!-- Embed code -->
    <div id="embedModal" class="modal fade-out">
        <div class="modal-content modal-form" role="dialog" aria-modal="true" aria-labelledby="embedTitle">
            <button type="button" class="close-btn" data-close-embed aria-label="Fechar"><i data-lucide="x"></i></button>
            <h2 id="embedTitle">Incorporar em um site</h2>
            <p class="modal-subtitle">Cada visitante que abrir a página ganha a própria tela, com QR e sincronia próprios.</p>

            <div class="embed-grid">
                <div class="form-group">
                    <label for="embedWidth">Largura (px)</label>
                    <input id="embedWidth" class="text-input" type="number" min="50" max="4000" value="360">
                </div>
                <div class="form-group">
                    <label for="embedHeight">Altura (px)</label>
                    <input id="embedHeight" class="text-input" type="number" min="50" max="4000" value="640">
                </div>
                <div class="form-group">
                    <label for="embedFit">Ajuste do vídeo</label>
                    <select id="embedFit" class="custom-select">
                        <option value="">Preencher (corta as bordas)</option>
                        <option value="contain">Mostrar inteiro (com faixas)</option>
                    </select>
                </div>
                <div class="form-group">
                    <label for="embedListen">No celular do visitante</label>
                    <select id="embedListen" class="custom-select">
                        <option value="">Automático ("Ouvir aqui" no celular)</option>
                        <option value="off">Sempre mostrar o QR</option>
                        <option value="on">Sempre "Ouvir aqui"</option>
                    </select>
                </div>
            </div>

            <label class="check-row"><input type="checkbox" id="embedResponsive" checked> Ocupar a largura do site (mantém a proporção)</label>
            <label class="check-row"><input type="checkbox" id="embedShowQr" checked> Mostrar o QR Code</label>

            <div class="form-group">
                <label for="embedCode">Código para colar no site</label>
                <textarea id="embedCode" class="text-input code-output" rows="5" readonly></textarea>
            </div>

            <div class="modal-actions">
                <a id="embedPreview" class="btn btn-ghost" href="#" target="_blank" rel="noopener"><i data-lucide="external-link"></i> Ver página</a>
                <span class="spacer"></span>
                <button type="button" class="btn btn-secondary" data-close-embed>Fechar</button>
                <button type="button" class="btn btn-primary" id="embedCopyBtn"><i data-lucide="copy"></i> Copiar código</button>
            </div>
        </div>
    </div>

```

E troque:

```html
    <script src="/static/js/admin.js"></script>
```

por:

```html
    <script src="/static/js/embed-code.js"></script>
    <script src="/static/js/admin.js"></script>
```

- [ ] **Step 6: Estilos**

No `static/css/admin.css`, logo antes de `/* ── Media library ── */`, adicione:

```css
/* ── Embed modal ── */
.embed-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.check-row { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-sm); }
.code-output { font-family: var(--font-mono); font-size: var(--text-xs); line-height: 1.5; resize: none; }
@media (max-width: 520px) { .embed-grid { grid-template-columns: 1fr; } }
```

- [ ] **Step 7: Botão no card e lógica do modal (`admin.js`)**

Em `renderTotems`, no template do card, troque:

```js
                        ${totem.configured ? `
                        <button type="button" class="icon-btn edit-btn"
```

por:

```js
                        ${totem.configured ? `
                        <button type="button" class="icon-btn embed-btn" title="Incorporar em um site" aria-label="Incorporar ${id}"><i data-lucide="code"></i></button>
                        <button type="button" class="icon-btn edit-btn"
```

Logo abaixo, troque:

```js
            if (totem.configured) {
                card.querySelector('.edit-btn').addEventListener('click', () => openTotemEditor(totem.id));
```

por:

```js
            if (totem.configured) {
                card.querySelector('.embed-btn').addEventListener('click', () => openEmbedEditor(totem.id));
                card.querySelector('.edit-btn').addEventListener('click', () => openTotemEditor(totem.id));
```

Logo antes de `// ── Mobile page links editor ───────────────────────`, adicione:

```js
    // ── Embed code modal ───────────────────────────────
    const embedModal = document.getElementById('embedModal');
    const embedFields = {
        width: document.getElementById('embedWidth'),
        height: document.getElementById('embedHeight'),
        fit: document.getElementById('embedFit'),
        listen: document.getElementById('embedListen'),
        responsive: document.getElementById('embedResponsive'),
        showQr: document.getElementById('embedShowQr'),
    };
    const embedCode = document.getElementById('embedCode');
    const embedPreview = document.getElementById('embedPreview');
    const embedCopyBtn = document.getElementById('embedCopyBtn');
    let embedCampaign = null;

    function embedOptions() {
        return {
            origin: location.origin,
            campaign: embedCampaign,
            width: embedFields.width.value,
            height: embedFields.height.value,
            fit: embedFields.fit.value,
            listen: embedFields.listen.value,
            responsive: embedFields.responsive.checked,
            showQr: embedFields.showQr.checked,
        };
    }

    function refreshEmbedCode() {
        if (!embedCampaign) return;
        const opts = embedOptions();
        embedCode.value = EmbedCode.buildEmbedCode(opts);
        embedPreview.href = EmbedCode.buildEmbedUrl(opts);
    }

    function openEmbedEditor(campaign) {
        embedCampaign = campaign;
        document.getElementById('embedTitle').textContent = `Incorporar em um site — ${campaign}`;
        refreshEmbedCode();
        embedModal.classList.remove('fade-out');
    }

    function closeEmbedEditor() {
        embedModal.classList.add('fade-out');
        embedCampaign = null;
    }

    Object.values(embedFields).forEach(el => el.addEventListener('input', refreshEmbedCode));
    embedModal.querySelectorAll('[data-close-embed]').forEach(btn => btn.addEventListener('click', closeEmbedEditor));
    embedModal.addEventListener('click', (e) => { if (e.target === embedModal) closeEmbedEditor(); });

    embedCopyBtn.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(embedCode.value);
        } catch (_) {
            // Clipboard API needs https/localhost; fall back to selecting the text
            embedCode.select();
            document.execCommand('copy');
        }
        embedCopyBtn.innerHTML = '<i data-lucide="check"></i> Copiado';
        lucide.createIcons();
        setTimeout(() => {
            embedCopyBtn.innerHTML = '<i data-lucide="copy"></i> Copiar código';
            lucide.createIcons();
        }, 1500);
    });
```

No listener de `keydown` (Escape), logo após a linha `if (!totemModal.classList.contains('fade-out')) closeTotemEditor();`, adicione:

```js
        if (!embedModal.classList.contains('fade-out')) closeEmbedEditor();
```

- [ ] **Step 8: Verificar e testar manualmente**

Run: `node -e "new Function(require('fs').readFileSync('static/js/admin.js','utf8'))" && npm test`
Expected: sem erro; todos `pass`.

Com `npm run dev`, no admin clique no ícone `</>` de um totem. Esperado: o código muda ao mexer nos campos; "Copiar código" copia; "Ver página" abre o totem com as opções; colar o código num `.html` qualquer mostra o vídeo.

- [ ] **Step 9: Commit**

```bash
git add static/js/embed-code.js tests/embed-code.test.js static/admin.html static/css/admin.css static/js/admin.js
git commit -m "feat(admin): generate iframe embed code per campaign"
```

---

### Task 5: Mídia por CDN (`MEDIA_BASE_URL`)

Cada visitante baixa o vídeo inteiro (o atual tem 45 MB). Com `MEDIA_BASE_URL` definido, totem e celular baixam a mídia do CDN/armazenamento (S3, Cloudflare R2…) em vez do servidor. Sem a variável, tudo continua em `/media`.

**Files:**
- Create: `lib/media-url.js`
- Test: `tests/media-url.test.js`, `tests/video-message.integration.test.js` (acrescentar)
- Modify: `server.js` (`videoMessage`, `handleMobile`), `static/js/totem.js` (`change_video`), `.env-example`

- [ ] **Step 1: Escrever o teste unitário que falha**

Crie `tests/media-url.test.js`:

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createMediaUrl } = require("../lib/media-url");

test("without a base URL, files are served from /media", () => {
  const url = createMediaUrl("");
  assert.equal(url("promo_video.mp4"), "/media/promo_video.mp4");
});

test("with a base URL, files point to the CDN", () => {
  const url = createMediaUrl("https://cdn.exemplo.com/audiosync/");
  assert.equal(url("promo_audio.mp3"), "https://cdn.exemplo.com/audiosync/promo_audio.mp3");
});

test("filenames are URL-encoded and empty names give null", () => {
  const url = createMediaUrl("https://cdn.exemplo.com");
  assert.equal(url("a b.mp4"), "https://cdn.exemplo.com/a%20b.mp4");
  assert.equal(url(""), null);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/media-url.test.js`
Expected: FAIL com `Cannot find module '../lib/media-url'`.

- [ ] **Step 3: Implementar**

Crie `lib/media-url.js`:

```js
// Public URL of a media file: the local /media route, or a CDN when
// MEDIA_BASE_URL is set (files must be uploaded there with the same names).
function createMediaUrl(baseUrl) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  return function mediaUrl(filename) {
    if (!filename) return null;
    const name = encodeURIComponent(filename);
    return base ? `${base}/${name}` : `/media/${name}`;
  };
}

module.exports = { createMediaUrl };
```

Run: `node --test tests/media-url.test.js`
Expected: 3 testes `pass`.

- [ ] **Step 4: Teste de integração que falha**

No fim de `tests/video-message.integration.test.js`, adicione:

```js
const { describe } = require("node:test");
const { mobileSync } = require("./helpers/ws");

describe("with MEDIA_BASE_URL", () => {
  let cdnServer;
  before(async () => {
    cdnServer = await startServer({
      totems: { camp: { video: "camp_video.mp4", audio: "camp_audio.mp3" } },
      env: { MEDIA_BASE_URL: "https://cdn.exemplo.com/audiosync" },
    });
  });
  after(() => cdnServer.stop());

  test("screens and phones get CDN URLs", async () => {
    const s = await registerScreen(cdnServer.wsBase, "camp", { instance: "cdn-a" });
    try {
      const msg = await s.next("change_video");
      assert.equal(msg.url, "https://cdn.exemplo.com/audiosync/camp_video.mp4");
      assert.equal(msg.audio, "https://cdn.exemplo.com/audiosync/camp_audio.mp3");
      const { sync } = await mobileSync(cdnServer.wsBase, "camp", "cdn-a");
      assert.equal(sync.audio, "https://cdn.exemplo.com/audiosync/camp_audio.mp3");
    } finally {
      s.close();
    }
  });
});
```

Run: `node --test tests/video-message.integration.test.js`
Expected: FAIL — `msg.url` é `undefined`.

- [ ] **Step 5: Usar no servidor**

No topo do `server.js`, após `const { createInstanceRegistry } = require("./lib/instances");`, adicione:

```js
const { createMediaUrl } = require("./lib/media-url");
```

Após a linha `const PUBLIC_URL = ...`, adicione:

```js
// Optional CDN/bucket for videos and audios (same filenames as assets/)
const mediaUrl = createMediaUrl(process.env.MEDIA_BASE_URL);
```

Substitua a função `videoMessage` (Task 2) por:

```js
// What a screen needs to play a campaign: the video, plus the audio for "Ouvir aqui"
function videoMessage(campaign) {
  const conf = totemsConf[campaign] || {};
  return {
    type: "change_video",
    filename: conf.video || "",
    url: mediaUrl(conf.video),
    audio: mediaUrl(conf.audio),
  };
}
```

Em `handleMobile`, troque:

```js
  const audio = conf && conf.audio ? `/media/${conf.audio}` : "/media/ivete_audio.mp3"; // fallback
```

por:

```js
  const audio = mediaUrl(conf && conf.audio) || mediaUrl("ivete_audio.mp3"); // fallback
```

- [ ] **Step 6: Totem usa a URL pronta**

Em `static/js/totem.js`, no ramo `change_video`, troque:

```js
                    video.src = `/media/${data.filename}`;
```

por:

```js
                    video.src = data.url || `/media/${data.filename}`;
```

- [ ] **Step 7: Rodar e ver passar**

Run: `npm test`
Expected: todos `pass` (o teste da Task 2 continua valendo: sem `MEDIA_BASE_URL`, `audio` é `/media/camp_audio.mp3`).

- [ ] **Step 8: Documentar**

No fim do `.env-example`, adicione:

```
# Opcional: servir vídeos e áudios de um CDN/armazenamento (S3, Cloudflare R2...)
# Os arquivos precisam estar lá com os mesmos nomes da pasta assets/, e o CDN
# precisa liberar CORS (o celular baixa o áudio com fetch). Vazio = /media local.
MEDIA_BASE_URL=
```

- [ ] **Step 9: Commit**

```bash
git add lib/media-url.js tests/media-url.test.js tests/video-message.integration.test.js server.js static/js/totem.js .env-example
git commit -m "feat: serve media from a CDN when MEDIA_BASE_URL is set"
```

---

### Task 6: Vídeo leve para sites no separador

Opção `web`: recodifica o vídeo em H.264 com qualidade de web (CRF 28, até ~2,5 Mbps, lado maior até 1920px). Um vídeo de 45 MB costuma cair para uma fração disso.

**Files:**
- Modify: `lib/media-splitter.js`, `scripts/split-media.js`, `server.js` (rota `/api/media/split`), `static/admin.html`, `static/css/admin.css`, `static/js/admin.js`
- Test: `tests/media-splitter.test.js`

- [ ] **Step 1: Escrever o teste que falha**

Crie `tests/media-splitter.test.js`:

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { splitMedia, probe } = require("../lib/media-splitter");

let hasFfmpeg = true;
try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); } catch { hasFfmpeg = false; }

// Big, high-bitrate test clip (2160x3840) with audio
function makeInput(dir) {
  const input = path.join(dir, "big.mp4");
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=2160x3840:rate=30:duration=1",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-c:v", "libx264", "-crf", "8", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", input,
  ]);
  return input;
}

test("web option re-encodes to a smaller H.264 capped at 1920px", { skip: !hasFfmpeg && "ffmpeg not installed" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "split-web-"));
  try {
    const input = makeInput(dir);
    const copy = await splitMedia(input, { outDir: path.join(dir, "copy") });
    const web = await splitMedia(input, { outDir: path.join(dir, "web"), web: true });

    assert.equal(copy.transcoded, false);
    assert.equal(web.transcoded, true);
    assert.equal(web.web, true);

    const info = await probe(web.video);
    assert.equal(info.video.codec, "h264");
    assert.equal(info.video.width, 1080);
    assert.equal(info.video.height, 1920);
    assert.ok(fs.statSync(web.video).size < fs.statSync(copy.video).size, "web version is smaller");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test tests/media-splitter.test.js`
Expected: FAIL — `web.transcoded` é `false` (ou `skip` se não houver ffmpeg; nesse caso instale-o antes de seguir).

- [ ] **Step 3: Implementar no separador**

Em `lib/media-splitter.js`, logo após a constante `PLAYABLE_CODECS`, adicione:

```js
// "web" option: smaller H.264 for sites — CRF 28, ~2.5 Mbps cap, longer side ≤ 1920px
const WEB_VIDEO_ARGS = [
  "-c:v", "libx264", "-preset", "medium", "-crf", "28",
  "-maxrate", "2500k", "-bufsize", "5000k", "-pix_fmt", "yuv420p",
  "-vf", "scale='if(gt(iw,ih),min(1920,iw),-2)':'if(gt(iw,ih),-2,min(1920,ih))'",
];
```

No comentário de opções de `splitMedia`, adicione a linha:

```js
 *   web           re-encode the video small for websites (default: false)
```

Troque:

```js
  let outExt = VIDEO_CONTAINERS[ext];
  const transcode = !PLAYABLE_CODECS[outExt].includes(info.video.codec);
  if (transcode) outExt = ".mp4";
```

por:

```js
  let outExt = VIDEO_CONTAINERS[ext];
  const web = !!options.web;
  const transcode = web || !PLAYABLE_CODECS[outExt].includes(info.video.codec);
  if (transcode) outExt = ".mp4";
```

Troque:

```js
      ...(transcode
        ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"]
        : ["-c:v", "copy"]),
```

por:

```js
      ...(web
        ? WEB_VIDEO_ARGS
        : transcode
          ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"]
          : ["-c:v", "copy"]),
```

Troque:

```js
  return { input, video: videoOut, audio: audioOut, duration: info.duration, transcoded: transcode };
```

por:

```js
  return { input, video: videoOut, audio: audioOut, duration: info.duration, transcoded: transcode, web };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test tests/media-splitter.test.js`
Expected: 1 teste `pass`.

- [ ] **Step 5: Flag `--web` no comando**

Em `scripts/split-media.js`, troque:

```js
  let overwrite = false;
```

por:

```js
  let overwrite = false;
  let web = false;
```

troque:

```js
    if (a === "--overwrite") overwrite = true;
```

por:

```js
    if (a === "--overwrite") overwrite = true;
    else if (a === "--web") web = true;
```

troque:

```js
      const r = await splitMedia(file, { outDir, overwrite });
```

por:

```js
      const r = await splitMedia(file, { outDir, overwrite, web });
```

e no texto de `usage()`, troque a linha do `--overwrite` por estas duas:

```
  --overwrite     substitui arquivos de saída que já existam
  --web           gera um vídeo menor, próprio para sites
```

- [ ] **Step 6: Rota do servidor**

Em `server.js`, na rota `app.post("/api/media/split", ...)`, troque:

```js
      const result = await splitMedia(tmpPath, { outDir: ASSETS_DIR, baseName: base, overwrite });
```

por:

```js
      const web = req.query.web === "1" || req.query.web === "true";
      const result = await splitMedia(tmpPath, { outDir: ASSETS_DIR, baseName: base, overwrite, web });
```

e troque:

```js
      res.status(201).json({ success: true, video, audio, transcoded: result.transcoded, duration: result.duration });
```

por:

```js
      res.status(201).json({ success: true, video, audio, transcoded: result.transcoded, web: result.web, duration: result.duration });
```

- [ ] **Step 7: Opção no admin**

Em `static/admin.html`, dentro de `<div id="splitDropZone" ...>`, logo após o `<input type="file" id="splitInput" ...>`, adicione:

```html
                    <label class="split-option" for="splitWeb">
                        <input type="checkbox" id="splitWeb"> Otimizar para sites (vídeo menor, demora mais)
                    </label>
```

No `static/css/admin.css`, logo após a regra `.drop-zone-split { ... }`, adicione:

```css
.drop-zone-split { flex-wrap: wrap; }
.split-option { display: flex; align-items: center; gap: var(--space-2); width: 100%; font-size: var(--text-xs); color: var(--text-primary); cursor: pointer; }
```

Em `static/js/admin.js`, em `splitFile`, troque:

```js
        const splitUrl = overwrite =>
            `/api/media/split?filename=${encodeURIComponent(file.name)}${overwrite ? '&overwrite=1' : ''}`;
```

por:

```js
        const web = document.getElementById('splitWeb').checked;
        const splitUrl = overwrite =>
            `/api/media/split?filename=${encodeURIComponent(file.name)}` +
            `${overwrite ? '&overwrite=1' : ''}${web ? '&web=1' : ''}`;
```

e troque:

```js
                item.done(`Separado: ${res.body.video} + ${res.body.audio}` +
                    (res.body.transcoded ? ' (vídeo convertido para tocar no navegador)' : ''));
```

por:

```js
                item.done(`Separado: ${res.body.video} + ${res.body.audio}` +
                    (res.body.web ? ' (vídeo otimizado para sites)'
                        : res.body.transcoded ? ' (vídeo convertido para tocar no navegador)' : ''));
```

- [ ] **Step 8: Verificar e commit**

Run: `node -e "new Function(require('fs').readFileSync('static/js/admin.js','utf8'))" && npm test`
Expected: sem erro; todos `pass`.

```bash
git add lib/media-splitter.js scripts/split-media.js server.js static/admin.html static/css/admin.css static/js/admin.js tests/media-splitter.test.js
git commit -m "feat(split): optional web-optimized video for embedding in sites"
```

---

### Task 7: Teste de carga e memória no `/health`

**Files:**
- Modify: `server.js` (`/health`), `package.json`
- Create: `scripts/load-test.js`

- [ ] **Step 1: Memória no `/health`**

Na rota `/health` do `server.js`, troque:

```js
    uptime_s: Math.round(process.uptime()),
```

por:

```js
    uptime_s: Math.round(process.uptime()),
    memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
```

- [ ] **Step 2: Script de carga**

Crie `scripts/load-test.js`:

```js
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
```

- [ ] **Step 3: Script no `package.json`**

Em `"scripts"`, adicione:

```json
    "load-test": "node scripts/load-test.js",
```

- [ ] **Step 4: Rodar uma carga pequena**

Em um terminal: `PORT=8077 npm start`. Em outro:

Run: `npm run load-test -- --url http://localhost:8077 --campaign totem1 --screens 100 --phones 2 --seconds 20`
Expected: linhas a cada 5s com `telas ok=100 falha=0 | celulares ok=200 falha=0`, `drift_checks` crescendo e a memória do servidor estável. Encerre o servidor de teste depois.

- [ ] **Step 5: Commit**

```bash
git add server.js package.json scripts/load-test.js
git commit -m "feat: add load test script and memory usage in /health"
```

---

### Task 8: Guia de incorporação e produção

**Files:**
- Create: `docs/incorporacao-e-producao.md`

- [ ] **Step 1: Escrever o guia**

Crie `docs/incorporacao-e-producao.md`:

````markdown
# Incorporação em sites e produção

## Conceitos

- **Campanha**: o que se configura no admin (vídeo, áudio, links do celular). No código e nas URLs ainda se chama `screen`/totem.
- **Instância**: cada tela tocando a campanha — um totem físico ou o iframe aberto por um visitante. É criada sozinha ao abrir a página e tem QR e sincronia próprios.

## Como incorporar

1. No admin, clique em `</>` no card da campanha.
2. Ajuste tamanho, ajuste do vídeo, QR e comportamento no celular.
3. Copie o código e cole no HTML do site.

Parâmetros da URL `/static/totem.html`:

| Parâmetro | Valores | Padrão |
|---|---|---|
| `screen` | ID da campanha | obrigatório |
| `fit` | `contain` mostra o vídeo inteiro | preenche e corta |
| `showqr` | `false` esconde o QR | mostra |
| `listen` | `on` / `off` / `auto` — botão "Ouvir aqui" no lugar do QR | `auto` (celular) |

## Checklist de produção

- [ ] Servidor com domínio próprio e **HTTPS** (não usar ngrok em produção).
- [ ] `ffmpeg` e `ffprobe` instalados (separador de vídeo e áudio).
- [ ] `.env` com `ADMIN_USER`, `ADMIN_PASSWORD` forte e `SESSION_SECRET` fixo.
- [ ] `PUBLIC_URL` com o domínio final.
- [ ] Atrás de proxy (Nginx, Cloudflare): `TRUST_PROXY=1`, e o proxy repassando WebSocket (`Upgrade`/`Connection`).
- [ ] Limites: `MAX_SCREENS_PER_IP` e `MAX_INSTANCES_PER_CAMPAIGN` de acordo com o público esperado.
- [ ] Vídeos de campanha separados com **"Otimizar para sites"**.
- [ ] Muitos visitantes: subir `assets/` para um CDN/armazenamento e definir `MEDIA_BASE_URL` (com CORS liberado para o domínio do servidor).
- [ ] Processo gerenciado (pm2, systemd ou o serviço da nuvem) para reiniciar em falhas.
- [ ] Rodar `npm run load-test` contra um ambiente de teste com o volume esperado.

## Limites conhecidos

- As sessões ficam na memória de **um** processo Node. Para rodar mais de um processo/servidor, seria preciso mover o registro de instâncias para um armazenamento compartilhado (ex.: Redis) e usar sessão fixa no balanceador. Um processo atende com folga centenas a alguns milhares de telas simultâneas — use o teste de carga para medir.
- Ao reiniciar o servidor, as telas reconectam sozinhas; celulares que estavam ouvindo precisam escanear de novo.
````

- [ ] **Step 2: Commit**

```bash
git add docs/incorporacao-e-producao.md
git commit -m "docs: add embedding and production guide"
```

- [ ] **Step 3: Suíte final e push (com autorização do usuário)**

Run: `npm test`
Expected: todos `pass`.

```bash
git push origin feat/campaign-instances
```

---

## Fora do escopo

- Rodar vários processos/servidores (Redis + sessão fixa) — só quando o teste de carga mostrar necessidade.
- Envio automático dos arquivos para o CDN pelo admin.
