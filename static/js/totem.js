// ── Config ─────────────────────────────────────────────
const urlParams = new URLSearchParams(window.location.search);
const SCREEN_ID = urlParams.get('screen') || "totem1";
// ?showqr=false|0|no|off hides the QR overlay (default: shown)
const SHOW_QR   = !["false", "0", "no", "off"].includes((urlParams.get('showqr') || "").toLowerCase());
// ?fit=contain shows the whole video (bars if the frame's aspect differs); default: cover (crop)
if ((urlParams.get('fit') || "").toLowerCase() === "contain") {
    document.querySelector(".totem-container").classList.add("fit-contain");
}
// ?listen=auto|on|off — "Ouvir aqui" instead of the QR. auto = touch screen up
// to 820px wide (a visitor's phone); a 1080px physical totem keeps the QR.
const LISTEN_PARAM = (urlParams.get('listen') || 'auto').toLowerCase();
const LISTEN_MODE = LISTEN_PARAM === 'on' ||
    (LISTEN_PARAM === 'auto' && matchMedia('(pointer: coarse)').matches && matchMedia('(max-width: 820px)').matches);
if (LISTEN_MODE) document.querySelector(".totem-container").classList.add("listen-mode");
const API_KEY   = "your-secret-api-key-here";
const WS_HOST   = location.host;
const WS_PROTO  = location.protocol === "https:" ? "wss" : "ws";
// One instance per page load: every screen/iframe gets its own sync session.
// (crypto.randomUUID only exists on https/localhost, hence the fallback.)
const INSTANCE_ID = (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const MOBILE_URL = `${location.protocol}//${location.host}/static/mobile.html` +
    `?screen=${encodeURIComponent(SCREEN_ID)}&instance=${INSTANCE_ID}`;

const video     = document.getElementById("video");
const statusDot = document.getElementById("statusDot");
const statusTxt = document.getElementById("statusText");
const qrOverlay = document.querySelector(".qr-overlay");

let registered = false;
let loopsToHide = 0;

// ── Generate QR ────────────────────────────────────────
if (SHOW_QR) {
    new QRCode(document.getElementById("qrWrapper"), {
        // Rendered large and scaled down by CSS (--qr-size) so it stays sharp at any frame size
        text: MOBILE_URL, width: 480, height: 480,
        colorDark: "#034a5d", colorLight: "#ffffff", // --db-blue-900 on white
        correctLevel: QRCode.CorrectLevel.H,
    });
    // Clicking the QR card opens the same page the QR points to (new tab, so an
    // embedding site isn't replaced)
    qrOverlay.href = MOBILE_URL;
} else {
    qrOverlay.remove();
}

// ── QR hide/show (hides for N video loops) ─────────────
function hideQrForLoops(count) {
    if (!SHOW_QR) return;
    loopsToHide = count;
    qrOverlay.classList.add("hidden");
    console.log(`[Totem] QR hidden for ${count} loops`);
}

// Detect video loop via 'seeked' (fires when <video loop> wraps to 0)
video.addEventListener("seeked", () => {
    if (loopsToHide > 0 && video.currentTime < 1) {
        loopsToHide--;
        console.log(`[Totem] Loop — ${loopsToHide} remaining`);
        if (loopsToHide <= 0) {
            qrOverlay.classList.remove("hidden");
            console.log("[Totem] QR visible again");
        }
    }
});

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
    // Keep the audio on the video's timeline (loops, stalls, seeks) and
    // playing whenever the video is playing
    audioSyncTimer = setInterval(() => {
        if (video.paused) return;
        if (LocalAudio.shouldResync(localAudio.currentTime, video.currentTime, video.duration || 0)) {
            localAudio.currentTime = video.currentTime;
        }
        if (localAudio.paused) localAudio.play().catch(() => {});
    }, 1000);
}

function stopListening() {
    listening = false;
    localAudio.pause();
    clearInterval(audioSyncTimer);
    updateListenBtn();
}

listenBtn.addEventListener("click", () => (listening ? stopListening() : startListening()));

// The audio follows the video: when the video pauses or waits for data
// (buffering, background tab), pause the audio too instead of running ahead.
// ("stalled" is not used: it fires while the video keeps playing.)
["pause", "waiting"].forEach(evt => video.addEventListener(evt, () => {
    if (listening) localAudio.pause();
}));
video.addEventListener("playing", () => {
    if (!listening) return;
    localAudio.currentTime = video.currentTime;
    localAudio.play().catch(err => console.error("[Totem] Local audio resume failed", err));
});

// ── Register session (WS stays open for notifications) ─
let screenWs = null;

function registerSession() {
    if (registered) return;
    registered = true;

    // Reconnects reuse INSTANCE_ID, so phones already synced keep their session
    const ws = new WebSocket(`${WS_PROTO}://${WS_HOST}/ws/screen/${SCREEN_ID}?instance=${INSTANCE_ID}&api_key=${API_KEY}`);
    screenWs = ws;

    ws.onopen = () => {
        // Send current_time — server computes start_time with its own clock
        ws.send(JSON.stringify({
            current_time: video.currentTime,
            duration: video.duration || 30,
            mode: "sync",
            drift_enabled: true,
        }));
        console.log(`[Totem] Session registered — ${video.duration}s, pos: ${video.currentTime.toFixed(2)}s`);
    };

    // Periodically send position updates so server recalculates start_time
    const posInterval = setInterval(() => {
        if (ws.readyState === 1) {
            ws.send(JSON.stringify({
                type: "position_update",
                current_time: video.currentTime,
            }));
        } else {
            clearInterval(posInterval);
        }
    }, 5000);

    ws.onmessage = (e) => {
        try {
            const data = JSON.parse(e.data);
            if (data.type === "mobile_connected") {
                hideQrForLoops(2);
            } else if (data.type === "change_screen" && data.screen) {
                // Renamed in the admin: reload under the new ID (new QR, new config)
                console.log(`[Totem] Screen renamed to ${data.screen} — reloading`);
                const params = new URLSearchParams(location.search);
                params.set("screen", data.screen);
                location.replace(`${location.pathname}?${params}`);
            } else if (data.type === "change_video") {
                setAudioUrl(data.audio);
                // Prevent infinite loop by checking if we are already playing this video
                if (!video.src.includes(data.filename)) {
                    console.log(`[Totem] Changing video to: ${data.filename}`);
                    const wasPlaying = !video.paused;
                    video.src = `/media/${data.filename}`;
                    video.load();
                    if (wasPlaying) {
                        video.play().catch(console.error);
                    }
                }
            }
        } catch (_) {}
    };

    ws.onerror = () => {
        registered = false;
    };

    ws.onclose = (e) => {
        // 4029 = screen limit reached: back off instead of hammering the server
        const delay = e.code === 4029 ? 60000 : 3000;
        console.log(`[Totem] WS closed (${e.code}) — reconnecting in ${delay / 1000}s`);
        clearInterval(posInterval);
        registered = false;
        screenWs = null;
        setTimeout(registerSession, delay);
    };
}

// ── Boot ───────────────────────────────────────────────
video.addEventListener("loadedmetadata", () => {
    console.log(`[Totem] Video ready — ${video.duration}s`);
    if (screenWs && screenWs.readyState === 1) {
        screenWs.send(JSON.stringify({
            current_time: video.currentTime,
            duration: video.duration || 30,
            mode: "sync",
            drift_enabled: true,
        }));
    }
});

// Initially register to catch configuration
registerSession();
