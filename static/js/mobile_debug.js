// ── Config ─────────────────────────────────────────────
const params    = new URLSearchParams(location.search);
const SCREEN_ID = params.get("screen") || "totem1";
const INSTANCE_ID = params.get("instance") || "";
const instanceQuery = id => (id ? `?instance=${encodeURIComponent(id)}` : "");
const WS_HOST   = location.host;
const WS_PROTO  = location.protocol === "https:" ? "wss" : "ws";

// Badge: campaign + first chars of the instance id
document.getElementById("screenBadge").textContent =
    SCREEN_ID.toUpperCase() + (INSTANCE_ID ? ` · ${INSTANCE_ID.slice(0, 8)}` : "");

// ── Elements ───────────────────────────────────────────
const tapOverlay = document.getElementById("tapOverlay");
const tapIcon    = document.getElementById("tapIcon");
const tapText    = document.getElementById("tapText");
const tapSub     = document.getElementById("tapSub");
const tapLoading = document.getElementById("tapLoading");
const mainUI     = document.getElementById("mainUI");
const bars       = document.querySelectorAll(".bar");
const audio      = document.getElementById("audioPlayer");

// ── Debug counters ─────────────────────────────────────
let hardCount = 0;
let historyEntries = [];
const MAX_HISTORY = 10;

function timeStr() {
    const d = new Date();
    return `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}:${d.getSeconds().toString().padStart(2,'0')}`;
}

function addHistory(type, msg) {
    const cls = type === "HARD" ? "entry-hard" : type === "SOFT" ? "entry-soft" : "entry-ok";
    historyEntries.unshift({ cls, msg: `[${timeStr()}] ${msg}` });
    if (historyEntries.length > MAX_HISTORY) historyEntries.pop();

    const el = document.getElementById("dbgHistory");
    el.innerHTML = historyEntries.map(e => `<div class="${e.cls}">${escapeHtml(e.msg)}</div>`).join("");
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── State ──────────────────────────────────────────────
// Same audio engine as the public page (static/js/sync-player.js)
const player = SyncPlayer.createPlayer({ audioEl: audio, log: addHistory });
let syncData      = null;
let driftWs       = null;
let userTapped    = false;
let playStartedAt = 0;

function showStatus(text, icon, sub) {
    tapText.textContent = text;
    tapIcon.innerHTML = `<i data-lucide="${icon}"></i>`;
    lucide.createIcons();
    tapSub.textContent = sub || "";
    tapSub.classList.toggle("hidden", !sub);
    tapLoading.classList.add("hidden");
}

function showSyncInfo(receivedAt) {
    const offset = syncData.server_time - receivedAt;
    const items = (syncData.items || []).length || 1;
    document.getElementById("dbgDuration").textContent =
        `${syncData.duration.toFixed(2)}s${items > 1 ? ` (${items} vídeos)` : ""}`;
    document.getElementById("dbgServerOffset").textContent = `${(offset * 1000).toFixed(0)}ms`;
    document.getElementById("dbgStartTime").textContent = syncData.start_time.toFixed(3);
}

// ── Start playback (on tap) ────────────────────────────
function startPlayback() {
    player.start().then(() => {
        playStartedAt = Date.now();
        tapOverlay.classList.add("fade-out");
        setTimeout(() => {
            tapOverlay.classList.add("hidden");
            mainUI.classList.remove("hidden");
        }, 400);
        startVisualizer();
        startDriftConnection();
        startDebugLoop();
    }).catch(err => {
        addHistory("HARD", `Falha ao tocar: ${err.message}`);
        showStatus("Toque novamente", "refresh-cw", "Erro ao iniciar áudio");
        userTapped = false;
    });
}

// ── TAP handler ────────────────────────────────────────
tapOverlay.addEventListener("click", () => {
    if (player.isPlaying()) return;
    userTapped = true;

    if (syncData) {
        startPlayback();
    } else {
        tapText.textContent = "Conectando...";
        tapIcon.innerHTML = '<i data-lucide="loader"></i>';
        lucide.createIcons();
        tapSub.classList.add("hidden");
        tapLoading.classList.remove("hidden");
    }
});

// ── Connect to mobile WS ──────────────────────────────
function connectSync() {
    const wsSendT = Date.now();
    const ws = new WebSocket(`${WS_PROTO}://${WS_HOST}/ws/mobile/${SCREEN_ID}${instanceQuery(INSTANCE_ID)}`);

    ws.onmessage = (e) => {
        const data = JSON.parse(e.data);
        const receivedAt = Date.now() / 1000;
        document.getElementById("dbgLatency").textContent = `${Date.now() - wsSendT}ms`;

        if (data.type === "sync") {
            syncData = data;
            player.setSync(data, receivedAt);
            showSyncInfo(receivedAt);
            renderPromo(data.promo);
            if (player.isPlaying()) addHistory("OK", "Sincronizado de novo (conteúdo mudou)");
            if (userTapped && !player.isPlaying()) startPlayback();
        }
    };

    ws.onerror = () => showStatus("Erro de conexão", "x-circle", "Toque para tentar novamente");

    ws.onclose = (e) => {
        if (e.code === 4004) {
            showStatus("Totem não encontrado", "radio", "Tentando novamente...");
            setTimeout(connectSync, 3000);
        } else if (e.code === 4010) {
            syncData = null;
            if (player.isPlaying()) {
                player.stop();
                if (driftWs) driftWs.close();
                mainUI.classList.add("hidden");
                tapOverlay.classList.remove("hidden", "fade-out");
            }
            addHistory("SOFT", "Nada no ar agora (fora do período)");
            showStatus("Nenhum anúncio no ar agora", "clock", "Tentando de novo em 30 segundos...");
            setTimeout(connectSync, 30000);
        } else if (e.code === 4029) {
            showStatus("Muitas conexões agora", "clock", "Tentando de novo em 30 segundos...");
            setTimeout(connectSync, 30000);
        }
    };
}

// ── Drift correction ───────────────────────────────────
function startDriftConnection() {
    if (!syncData || !syncData.drift_enabled) return;
    if (driftWs && driftWs.readyState <= 1) return;

    driftWs = new WebSocket(`${WS_PROTO}://${WS_HOST}/ws/drift/${SCREEN_ID}${instanceQuery(syncData.instance || INSTANCE_ID)}`);

    driftWs.onmessage = (e) => {
        const data = JSON.parse(e.data);

        if (data.type === "drift_check" && player.isPlaying()) {
            driftWs.send(JSON.stringify({ type: "position_report", position: player.position() }));
        }

        if (data.type === "drift_correction" && player.isPlaying()) {
            if (Date.now() - playStartedAt < 5000) return;

            const dbgDrift = document.getElementById("dbgDrift");
            const dbgStatus = document.getElementById("dbgStatus");
            dbgDrift.textContent = `${data.drift_ms}ms`;

            if (data.mode === "HARD") {
                hardCount++;
                document.getElementById("dbgHardCount").textContent = hardCount;
                dbgDrift.className = "metric-value bad";
                dbgStatus.className = "status-pill correcting";
                dbgStatus.textContent = "RESSINCRONIZANDO";
                player.seek(data.target_time);
                document.getElementById("dbgLastCorrection").textContent = `HARD ${data.drift_ms}ms @ ${timeStr()}`;
                addHistory("HARD", `Pulou para ${data.target_time.toFixed(2)}s (${data.drift_ms}ms)`);
            }
        }

        if (data.type === "drift_ok") {
            const dbgDrift = document.getElementById("dbgDrift");
            const dbgStatus = document.getElementById("dbgStatus");
            dbgDrift.textContent = "< 80ms";
            dbgDrift.className = "metric-value good";
            dbgStatus.className = "status-pill ok";
            dbgStatus.textContent = "OK ✓";
        }

        if (data.type === "content_changed") {
            addHistory("SOFT", "A tela trocou o conteúdo — sincronizando de novo");
            connectSync();
        }
    };

    driftWs.onclose = () => addHistory("HARD", "Conexão de desvio caiu");
}

// ── Visualizer ─────────────────────────────────────────
function startVisualizer() {
    function animate() {
        if (!player.isPlaying()) return;
        bars.forEach(bar => {
            bar.style.height = `${4 + Math.random() * 40}px`;
        });
        requestAnimationFrame(animate);
    }
    animate();
}

// ── Debug update loop ──────────────────────────────────
function startDebugLoop() {
    function tick() {
        if (!player.isPlaying() || !syncData) return;

        document.getElementById("dbgRealPos").textContent = `${player.position().toFixed(2)}s`;
        document.getElementById("dbgExpectedPos").textContent = `${player.expected().toFixed(2)}s`;

        const rateEl = document.getElementById("dbgRate");
        rateEl.textContent = player.isWebAudio() ? "WebAudio ✓" : "<audio> (carregando...)";
        rateEl.className = player.isWebAudio() ? "metric-value good" : "metric-value";

        document.getElementById("dbgBuffer").textContent = `${player.itemIndex() + 1} de ${player.itemCount()}`;

        requestAnimationFrame(tick);
    }
    tick();
}

// ── Init ───────────────────────────────────────────────
connectSync();

document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !syncData) {
        connectSync();
    }
});
