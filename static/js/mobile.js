// ── Config ─────────────────────────────────────────────
const params    = new URLSearchParams(location.search);
const SCREEN_ID = params.get("screen") || "totem1";
const WS_HOST   = location.host;
const WS_PROTO  = location.protocol === "https:" ? "wss" : "ws";
const AUDIO_URL = "/media/ivete_audio.mp3";

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

// Set audio source for <audio> element
audio.src = AUDIO_URL;
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

    // Mute <audio> but keep it playing (keeps iOS session alive)
    // iOS ignores .volume=0, MUST use .muted=true
    audio.muted = true;
    audio.volume = 0;
    console.log(`[Hybrid] Switched to WebAudio at ${position.toFixed(2)}s`);
}

// ── Background: fetch + decode + switch ────────────────
async function loadAndSwitch() {
    try {
        // AudioContext is now created synchronously in startPlayback()
        const response = await fetch(AUDIO_URL);
        const arrayBuf = await response.arrayBuffer();
        audioBuffer = await audioCtx.decodeAudioData(arrayBuf);

        console.log(`[Hybrid] Buffer ready: ${audioBuffer.duration.toFixed(2)}s`);
        switchToWebAudio();
    } catch (err) {
        console.warn("[Hybrid] WebAudio failed, staying with <audio>:", err);
    }
}

// 1-second silent MP3 base64 to keep iOS session permanently active
const SILENT_MP3 = "data:audio/mp3;base64,//OExAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq//OExAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq//OExAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
let keepAliveAudio = null;

// ── Start playback (on tap) ────────────────────────────
// STEP 1: audio.play() → activates iOS session + immediate sound
// STEP 2: Play base64 silence loop → tricks iOS into keeping session permanently active
// STEP 3: create AudioContext synchronously in gesture!
// STEP 4: loadAndSwitch() → fetch/decode in background
// STEP 5: switchToWebAudio() → seamless handoff
function startPlayback() {
    const position = calcCurrentPosition();

    // CRITICAL FOR iOS: Play a real <audio> element in a loop
    // with a silent base64 MP3 to trick native iOS into keeping
    // the Web Audio Context fully unlocked and running.
    if (!keepAliveAudio) {
        keepAliveAudio = new Audio(SILENT_MP3);
        keepAliveAudio.loop = true;
        // keepAliveAudio.muted = true;
        keepAliveAudio.play().catch(e => console.warn("[Hybrid] Keep-alive failed", e));
    }

    // MUST create/resume AudioContext synchronously in the gesture handler!
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === "suspended") {
        audioCtx.resume();
    }

    // CRITICAL FOR iOS: Play a silent buffer immediately inside the tap
    // event to fully unlock the Web Audio API context.
    try {
        const emptyBuffer = audioCtx.createBuffer(1, 1, 22050);
        const unlockSource = audioCtx.createBufferSource();
        unlockSource.buffer = emptyBuffer;
        unlockSource.connect(audioCtx.destination);
        unlockSource.start(0);
    } catch (e) {
        console.warn("[Hybrid] Unlock silence failed:", e);
    }

    audio.play().then(() => {
        audio.currentTime = position;
        console.log(`[Hybrid] <audio> playing from ${position.toFixed(2)}s`);

        isPlaying = true;
        playStartedAt = Date.now();

        tapOverlay.classList.add("fade-out");
        setTimeout(() => {
            tapOverlay.classList.add("hidden");
            mainUI.classList.remove("hidden");
        }, 400);

        startVisualizer();
        startDriftConnection();

        // Load Web Audio in background and switch when ready
        loadAndSwitch();

    }).catch(err => {
        console.error("[Hybrid] Play failed:", err);
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
    }
});

// ── Connect to mobile WS ──────────────────────────────
function connectSync() {
    const ws = new WebSocket(`${WS_PROTO}://${WS_HOST}/ws/mobile/${SCREEN_ID}`);

    ws.onmessage = (e) => {
        const data = JSON.parse(e.data);
        localReceiveT = Date.now() / 1000;

        if (data.type === "sync") {
            syncData = data;
            if (userTapped && !isPlaying) startPlayback();
        }
    };

    ws.onerror = () => {
        tapText.textContent = "Erro de conexão";
        tapIcon.innerHTML = '<i data-lucide="x-circle"></i>';
        lucide.createIcons();
        tapSub.textContent = "Toque para tentar novamente";
        tapSub.classList.remove("hidden");
        tapLoading.classList.add("hidden");
    };

    ws.onclose = (e) => {
        if (e.code === 4004) {
            tapText.textContent = "Totem não encontrado";
            tapIcon.innerHTML = '<i data-lucide="radio"></i>';
            lucide.createIcons();
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
            // SOFT: ignored — no playbackRate changes
        }
    };

    driftWs.onclose = () => console.log("[Hybrid] Drift WS closed");
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

document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !syncData) {
        connectSync();
    }
});

// ── App Download Button Logic ──────────────────────────
const btnDownloadApp = document.getElementById("btnDownloadApp");
if (btnDownloadApp) {
    btnDownloadApp.addEventListener("click", (e) => {
        e.preventDefault();
        const userAgent = navigator.userAgent || navigator.vendor || window.opera;
        
        if (/iPad|iPhone|iPod/.test(userAgent) && !window.MSStream) {
            // iOS: App Store link (using generic 99 app link for demonstration)
            window.location.href = "https://apps.apple.com/br/app/99-corridas-food-pay/id553663691";
        } else if (/android/i.test(userAgent)) {
            // Android: Play Store link
            window.location.href = "https://play.google.com/store/apps/details?id=com.taxis99";
        } else {
            // Fallback for Desktop/Other: 99Food site
            window.location.href = "https://99app.com/99food/";
        }
    });
}
