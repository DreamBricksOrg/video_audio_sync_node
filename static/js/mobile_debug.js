// ── Config ─────────────────────────────────────────────
const params    = new URLSearchParams(location.search);
const SCREEN_ID = params.get("screen") || "totem1";
const WS_HOST   = location.host;
const WS_PROTO  = location.protocol === "https:" ? "wss" : "ws";
const AUDIO_URL = "/media/99_audio.mp3";

document.getElementById("screenBadge").textContent = SCREEN_ID.toUpperCase();

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

// Set audio source
audio.src = AUDIO_URL;
audio.loop = true;

// ── Debug counters ─────────────────────────────────────
let hardCount = 0;
let historyEntries = [];
const MAX_HISTORY = 10;

// ── Helpers ────────────────────────────────────────────
function timeStr() {
    const d = new Date();
    return `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}:${d.getSeconds().toString().padStart(2,'0')}`;
}

function addHistory(type, msg) {
    const cls = type === "HARD" ? "entry-hard" : type === "SOFT" ? "entry-soft" : "entry-ok";
    historyEntries.unshift({ cls, msg: `[${timeStr()}] ${msg}` });
    if (historyEntries.length > MAX_HISTORY) historyEntries.pop();

    const el = document.getElementById("dbgHistory");
    el.innerHTML = historyEntries.map(e =>
        `<div class="${e.cls}">${e.msg}</div>`
    ).join("");
}

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
    addHistory("OK", `Switched to WebAudio at ${position.toFixed(2)}s`);
}

// ── Background: fetch + decode + switch ────────────────
async function loadAndSwitch() {
    try {
        // AudioContext created synchronously in startPlayback()
        addHistory("OK", "Fetching audio buffer...");
        const response = await fetch(AUDIO_URL);
        const arrayBuf = await response.arrayBuffer();
        const sizeMB = (arrayBuf.byteLength / 1024 / 1024).toFixed(1);

        audioBuffer = await audioCtx.decodeAudioData(arrayBuf);
        addHistory("OK", `Decoded: ${audioBuffer.duration.toFixed(1)}s, ${sizeMB}MB`);

        switchToWebAudio();
    } catch (err) {
        addHistory("HARD", `WebAudio failed: ${err.message} — using <audio>`);
    }
}

// 1-second silent MP3 base64 to keep iOS session permanently active
const SILENT_MP3 = "data:audio/mp3;base64,//OExAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq//OExAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq//OExAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
let keepAliveAudio = null;

// ── Start playback (on tap) ────────────────────────────
function startPlayback() {
    const position = calcCurrentPosition();

    // CRITICAL FOR iOS: Play a real <audio> element in a loop
    // with a silent base64 MP3 to trick native iOS into keeping
    // the Web Audio Context fully unlocked and running.
    if (!keepAliveAudio) {
        keepAliveAudio = new Audio(SILENT_MP3);
        keepAliveAudio.loop = true;
        // keepAliveAudio.muted = true;
        keepAliveAudio.play().catch(e => addHistory("HARD", "Keep-alive failed"));
    }

    // MUST create/resume AudioContext synchronously in the gesture handler!
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === "suspended") {
        audioCtx.resume();
    }
    addHistory("OK", `AudioContext: ${audioCtx.state}`);

    // CRITICAL FOR iOS: Play a silent buffer immediately inside the tap
    // event to fully unlock the Web Audio API context.
    try {
        const emptyBuffer = audioCtx.createBuffer(1, 1, 22050);
        const unlockSource = audioCtx.createBufferSource();
        unlockSource.buffer = emptyBuffer;
        unlockSource.connect(audioCtx.destination);
        unlockSource.start(0);
    } catch (e) {
        addHistory("HARD", "Unlock silence failed");
    }

    audio.play().then(() => {
        audio.currentTime = position;
        addHistory("OK", `<audio> playing from ${position.toFixed(2)}s`);

        isPlaying = true;
        playStartedAt = Date.now();

        tapOverlay.classList.add("fade-out");
        setTimeout(() => {
            tapOverlay.classList.add("hidden");
            mainUI.classList.remove("hidden");
        }, 400);

        const offset = syncData.server_time - localReceiveT;
        document.getElementById("dbgDuration").textContent = `${syncData.duration.toFixed(2)}s`;
        document.getElementById("dbgServerOffset").textContent = `${(offset * 1000).toFixed(0)}ms`;
        document.getElementById("dbgStartTime").textContent = syncData.start_time.toFixed(3);

        startVisualizer();
        startDriftConnection();
        startDebugLoop();

        // Background: load Web Audio and switch
        loadAndSwitch();

    }).catch(err => {
        addHistory("HARD", `Play failed: ${err.message}`);
        tapText.textContent = "Toque novamente";
        tapIcon.textContent = "🔄";
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
        tapIcon.textContent = "⏳";
        tapSub.classList.add("hidden");
        tapLoading.classList.remove("hidden");
    }
});

// ── Connect to mobile WS ──────────────────────────────
function connectSync() {
    const wsSendT = Date.now();
    const ws = new WebSocket(`${WS_PROTO}://${WS_HOST}/ws/mobile/${SCREEN_ID}`);

    ws.onmessage = (e) => {
        const data = JSON.parse(e.data);
        localReceiveT = Date.now() / 1000;

        const latency = Date.now() - wsSendT;
        document.getElementById("dbgLatency").textContent = `${latency}ms`;

        if (data.type === "sync") {
            syncData = data;
            if (userTapped && !isPlaying) startPlayback();
        }
    };

    ws.onerror = () => {
        tapText.textContent = "Erro de conexão";
        tapIcon.textContent = "❌";
        tapSub.textContent = "Toque para tentar novamente";
        tapSub.classList.remove("hidden");
        tapLoading.classList.add("hidden");
    };

    ws.onclose = (e) => {
        if (e.code === 4004) {
            tapText.textContent = "Totem não encontrado";
            tapIcon.textContent = "📡";
            tapSub.textContent = "Tentando novamente...";
            tapSub.classList.remove("hidden");
            setTimeout(connectSync, 3000);
        }
    };
}

// ── Drift correction ───────────────────────────────────
function startDriftConnection() {
    if (!syncData || !syncData.drift_enabled) return;

    driftWs = new WebSocket(`${WS_PROTO}://${WS_HOST}/ws/drift/${SCREEN_ID}`);

    driftWs.onmessage = (e) => {
        const data = JSON.parse(e.data);

        if (data.type === "drift_check" && isPlaying) {
            driftWs.send(JSON.stringify({
                type: "position_report",
                position: getPlaybackPosition(),
            }));

            document.getElementById("dbgExpectedPos").textContent =
                `${data.expected_position.toFixed(2)}s`;
        }

        if (data.type === "drift_correction" && isPlaying) {
            if (Date.now() - playStartedAt < 5000) return;

            const dbgDrift = document.getElementById("dbgDrift");
            const dbgStatus = document.getElementById("dbgStatus");
            dbgDrift.textContent = `${data.drift_ms}ms`;

            if (data.mode === "HARD") {
                hardCount++;
                document.getElementById("dbgHardCount").textContent = hardCount;
                dbgDrift.className = "metric-value bad";
                dbgStatus.className = "status-pill correcting";
                dbgStatus.textContent = "RESYNC ⚡";

                if (usingWebAudio) {
                    webAudioPlayFrom(data.target_time);
                } else {
                    audio.currentTime = data.target_time;
                }
                
                document.getElementById("dbgLastCorrection").textContent =
                    `HARD ${data.drift_ms}ms @ ${timeStr()}`;
                addHistory("HARD", `Seek to ${data.target_time.toFixed(2)}s (${data.drift_ms}ms)`);
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
    };

    driftWs.onclose = () => addHistory("HARD", "Drift WS disconnected");
}

// ── Visualizer ─────────────────────────────────────────
function startVisualizer() {
    function animate() {
        if (!isPlaying) return;
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
        if (!isPlaying || !syncData) return;

        const pos = getPlaybackPosition();
        document.getElementById("dbgRealPos").textContent = `${pos.toFixed(2)}s`;

        const rateEl = document.getElementById("dbgRate");
        rateEl.textContent = usingWebAudio ? "WebAudio ✓" : "<audio> (loading...)";
        rateEl.className = usingWebAudio ? "metric-value good" : "metric-value";

        document.getElementById("dbgBuffer").textContent =
            usingWebAudio ? "100% (RAM)" : `${audio.buffered.length > 0 ? ((audio.buffered.end(audio.buffered.length - 1) / audio.duration) * 100).toFixed(0) : 0}%`;

        const expected = calcCurrentPosition();
        document.getElementById("dbgExpectedPos").textContent = `${expected.toFixed(2)}s`;

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
