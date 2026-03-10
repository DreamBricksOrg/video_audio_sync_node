// ── Config ─────────────────────────────────────────────
const WS_HOST  = location.host;
const WS_PROTO = location.protocol === "https:" ? "wss" : "ws";

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
let syncData      = null;
let isPlaying     = false;
let driftWs       = null;
let userTapped    = false;
let localReceiveT = 0;
let playStartedAt = 0;

// ── Web Audio API state ────────────────────────────────
let audioCtx       = null;
let audioBuffer    = null;
let sourceNode     = null;
let startCtxTime   = 0;
let startOffset    = 0;
let usingWebAudio  = false;

audio.loop = true;

// ── Helpers ────────────────────────────────────────────
function calcPosition(serverTime, startTime, duration) {
    return ((serverTime - startTime) % duration + duration) % duration;
}

function calcCurrentPosition() {
    if (!syncData) return 0;
    const now = Date.now() / 1000;
    const serverOffset = syncData.server_time - localReceiveT;
    const serverNow = now + serverOffset;
    return calcPosition(serverNow, syncData.start_time, syncData.duration);
}

function getPlaybackPosition() {
    if (usingWebAudio && audioCtx) {
        const elapsed = audioCtx.currentTime - startCtxTime;
        const dur = audioBuffer ? audioBuffer.duration : (syncData ? syncData.duration : 1);
        return ((startOffset + elapsed) % dur + dur) % dur;
    }
    return audio.currentTime;
}

// ── Web Audio: play from offset ────────────────────────
function webAudioPlayFrom(offset) {
    if (sourceNode) {
        try { sourceNode.onended = null; sourceNode.stop(); } catch(e) {}
    }

    sourceNode = audioCtx.createBufferSource();
    sourceNode.buffer = audioBuffer;
    sourceNode.connect(audioCtx.destination);

    sourceNode.onended = () => {
        if (isPlaying && syncData) {
            webAudioPlayFrom(calcCurrentPosition());
        }
    };

    startOffset  = offset % audioBuffer.duration;
    startCtxTime = audioCtx.currentTime;

    const remaining = audioBuffer.duration - startOffset;
    sourceNode.start(0, startOffset, remaining);
}

// ── Handoff: <audio> → Web Audio API ───────────────────
function switchToWebAudio() {
    const position = calcCurrentPosition();
    webAudioPlayFrom(position);
    usingWebAudio = true;

    audio.muted = true;
    audio.volume = 0;
    console.log(`[Audio] Switched to WebAudio at ${position.toFixed(2)}s`);
}

// ── Background: fetch + decode + switch ────────────────
async function loadAndSwitch() {
    try {
        if (!syncData || !syncData.audio) return;

        const response = await fetch(syncData.audio);
        const arrayBuf = await response.arrayBuffer();
        audioBuffer = await audioCtx.decodeAudioData(arrayBuf);

        console.log(`[Audio] Buffer ready: ${audioBuffer.duration.toFixed(2)}s`);
        switchToWebAudio();
    } catch (err) {
        console.warn("[Audio] WebAudio failed, staying with <audio>:", err);
    }
}

// 1-second silent MP3 base64 to keep iOS session permanently active
const SILENT_MP3 = "data:audio/mp3;base64,//OExAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq//OExAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq//OExAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
let keepAliveAudio = null;

// ── Start playback (on tap) ────────────────────────────
function startPlayback() {
    const position = calcCurrentPosition();

    // Keep-alive for iOS
    if (!keepAliveAudio) {
        keepAliveAudio = new Audio(SILENT_MP3);
        keepAliveAudio.loop = true;
        keepAliveAudio.play().catch(e => console.warn("[Audio] Keep-alive failed", e));
    }

    // AudioContext
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === "suspended") {
        audioCtx.resume();
    }

    // Unlock silence
    try {
        const emptyBuffer = audioCtx.createBuffer(1, 1, 22050);
        const unlockSource = audioCtx.createBufferSource();
        unlockSource.buffer = emptyBuffer;
        unlockSource.connect(audioCtx.destination);
        unlockSource.start(0);
    } catch (e) {
        console.warn("[Audio] Unlock silence failed:", e);
    }

    // Set audio track
    if (syncData && syncData.audio) {
        if (audio.src !== window.location.origin + syncData.audio) {
            audio.src = syncData.audio;
            audio.load();
        }
    }

    audio.play().then(() => {
        audio.currentTime = position;
        console.log(`[Audio] <audio> playing from ${position.toFixed(2)}s`);

        isPlaying = true;
        playStartedAt = Date.now();

        tapOverlay.classList.add("fade-out");
        setTimeout(() => {
            tapOverlay.classList.add("hidden");
            mainUI.classList.remove("hidden");
        }, 400);

        startVisualizer();

        // Load Web Audio in background and switch when ready
        loadAndSwitch();

    }).catch(err => {
        console.error("[Audio] Play failed:", err);
        tapText.textContent = "Toque novamente";
        tapIcon.innerHTML = '<i data-lucide="refresh-cw"></i>';
        lucide.createIcons();
        tapSub.textContent = "Erro ao iniciar áudio";
        tapSub.classList.remove("hidden");
        tapLoading.classList.add("hidden");
        userTapped = false;
    });
}

// ── TAP handler ────────────────────────────────────────
tapOverlay.addEventListener("click", () => {
    if (isPlaying) return;
    userTapped = true;

    if (syncData) {
        startPlayback();
    } else {
        tapText.textContent = "Conectando...";
        tapIcon.innerHTML = '<i data-lucide="loader"></i>';
        lucide.createIcons();
        tapSub.classList.add("hidden");
        tapLoading.classList.remove("hidden");
        connectSync();
    }
});

// ── Connect to sync WS ────────────────────────────────
function connectSync() {
    const ws = new WebSocket(`${WS_PROTO}://${WS_HOST}/ws/sync`);

    ws.onmessage = (e) => {
        const data = JSON.parse(e.data);
        localReceiveT = Date.now() / 1000;

        if (data.type === "sync") {
            syncData = data;
            driftWs = ws; // reuse this connection for drift
            if (userTapped && !isPlaying) startPlayback();
        }

        // Drift handling — update sync data on every check to stay accurate across VLC loops
        if (data.type === "drift_check" && isPlaying) {
            // Keep syncData fresh with server's latest timing
            syncData.start_time = data.start_time;
            syncData.server_time = data.server_time;
            syncData.duration = data.duration;
            localReceiveT = Date.now() / 1000;

            ws.send(JSON.stringify({
                type: "position_report",
                position: getPlaybackPosition(),
            }));
        }

        if (data.type === "drift_correction" && isPlaying) {
            if (Date.now() - playStartedAt < 5000) return;

            if (data.mode === "HARD") {
                if (usingWebAudio) {
                    webAudioPlayFrom(data.target_time);
                } else {
                    audio.currentTime = data.target_time;
                }
            }
        }
    };

    ws.onerror = () => {
        tapText.textContent = "Erro de conexão";
        tapIcon.innerHTML = '<i data-lucide="x-circle"></i>';
        lucide.createIcons();
        tapSub.textContent = "Toque para tentar novamente";
        tapSub.classList.remove("hidden");
        tapLoading.classList.add("hidden");
        userTapped = false;
    };

    ws.onclose = () => {
        console.log("[Audio] WS closed");
        if (isPlaying) {
            // Reconnect for continued drift correction
            setTimeout(connectSync, 3000);
        }
    };
}

// ── Visualizer ─────────────────────────────────────────
function startVisualizer() {
    function animate() {
        if (!isPlaying) return;
        bars.forEach(bar => {
            bar.style.height = `${4 + Math.random() * 52}px`;
        });
        requestAnimationFrame(animate);
    }
    animate();
}

// ── Init ───────────────────────────────────────────────
connectSync();
