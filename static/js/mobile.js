// ── Config ─────────────────────────────────────────────
const params    = new URLSearchParams(location.search);
const SCREEN_ID = params.get("screen") || "totem1";
// Screen this phone follows (from the QR). Empty = legacy QR → server picks the newest screen.
const INSTANCE_ID = params.get("instance") || "";
const instanceQuery = id => (id ? `?instance=${encodeURIComponent(id)}` : "");
const WS_HOST   = location.host;
const WS_PROTO  = location.protocol === "https:" ? "wss" : "ws";

// ── Elements ───────────────────────────────────────────
const tapOverlay = document.getElementById("tapOverlay");
const tapIcon    = document.getElementById("tapIcon");
const tapText    = document.getElementById("tapText");
const tapSub     = document.getElementById("tapSub");
const tapLoading = document.getElementById("tapLoading");
const mainUI     = document.getElementById("mainUI");
const bars       = document.querySelectorAll(".bar");
const audio      = document.getElementById("audioPlayer");

// ── State ──────────────────────────────────────────────
// Audio engine (static/js/sync-player.js): plays each video's audio in turn,
// on the screen's timeline
const player = SyncPlayer.createPlayer({ audioEl: audio, log: (type, msg) => console.log(`[Player] ${msg}`) });
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
    }).catch(err => {
        console.error("[Player] Play failed:", err);
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
    const ws = new WebSocket(`${WS_PROTO}://${WS_HOST}/ws/mobile/${SCREEN_ID}${instanceQuery(INSTANCE_ID)}`);

    ws.onmessage = (e) => {
        const data = JSON.parse(e.data);
        if (data.type === "sync") {
            syncData = data;
            player.setSync(data, Date.now() / 1000);
            renderPromo(data.promo);
            if (userTapped && !player.isPlaying()) startPlayback();
        }
    };

    ws.onerror = () => showStatus("Erro de conexão", "x-circle", "Toque para tentar novamente");

    ws.onclose = (e) => {
        if (e.code === 4004) {
            showStatus("Totem não encontrado", "radio", "Tentando novamente...");
            setTimeout(connectSync, 3000);
        } else if (e.code === 4010) {
            // Nothing on air right now (outside the campaign's period)
            stopForIdle();
            showStatus("Nenhum anúncio no ar agora", "clock", "O áudio começa sozinho quando voltar");
            setTimeout(connectSync, 30000);
        } else if (e.code === 4029) {
            // Too many phones on this network right now: wait and try again
            showStatus("Muitas conexões agora", "clock", "Tentando de novo em 30 segundos...");
            setTimeout(connectSync, 30000);
        }
    };
}

function stopForIdle() {
    syncData = null;
    if (!player.isPlaying()) return;
    player.stop();
    if (driftWs) driftWs.close();
    // Back to the overlay; the tap already happened, so audio resumes by itself
    // when the campaign is on air again (if the browser allows it)
    mainUI.classList.add("hidden");
    tapOverlay.classList.remove("hidden", "fade-out");
}

// ── Drift correction ───────────────────────────────────
function startDriftConnection() {
    if (!syncData || !syncData.drift_enabled) return;
    if (driftWs && driftWs.readyState <= 1) return;

    // Use the instance the server actually synced us to (matters for legacy QRs)
    driftWs = new WebSocket(`${WS_PROTO}://${WS_HOST}/ws/drift/${SCREEN_ID}${instanceQuery(syncData.instance || INSTANCE_ID)}`);

    driftWs.onmessage = (e) => {
        const data = JSON.parse(e.data);

        if (data.type === "drift_check" && player.isPlaying()) {
            driftWs.send(JSON.stringify({ type: "position_report", position: player.position() }));
        }

        if (data.type === "drift_correction" && player.isPlaying()) {
            if (Date.now() - playStartedAt < 5000) return;
            if (data.mode === "HARD") player.seek(data.target_time);
            // SOFT: ignored — no playbackRate changes
        }

        // The screen changed videos (playlist edit, schedule): sync again
        if (data.type === "content_changed") connectSync();
    };

    driftWs.onclose = () => console.log("[Player] Drift WS closed");
}

// ── Visualizer ─────────────────────────────────────────
function startVisualizer() {
    function animate() {
        if (!player.isPlaying()) return;
        bars.forEach(bar => {
            bar.style.height = `${4 + Math.random() * 52}px`;
        });
        requestAnimationFrame(animate);
    }
    animate();
}

// ── Init ───────────────────────────────────────────────
connectSync();

document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !syncData) {
        connectSync();
    }
});
