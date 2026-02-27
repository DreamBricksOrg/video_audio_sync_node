// ── Config ─────────────────────────────────────────────
const urlParams = new URLSearchParams(window.location.search);
const SCREEN_ID = urlParams.get('screen') || "totem1";
const API_KEY   = "your-secret-api-key-here";
const WS_HOST   = location.host;
const WS_PROTO  = location.protocol === "https:" ? "wss" : "ws";
const MOBILE_URL = `${location.protocol}//${location.host}/static/mobile.html?screen=${SCREEN_ID}`;

const video     = document.getElementById("video");
const statusDot = document.getElementById("statusDot");
const statusTxt = document.getElementById("statusText");
const qrOverlay = document.querySelector(".qr-overlay");

let registered = false;
let loopsToHide = 0;

// ── Generate QR ────────────────────────────────────────
new QRCode(document.getElementById("qrWrapper"), {
    text: MOBILE_URL, width: 200, height: 200,
    colorDark: "#000000", colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.H,
});

// ── QR hide/show (hides for N video loops) ─────────────
function hideQrForLoops(count) {
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

// ── Register session (WS stays open for notifications) ─
let screenWs = null;

function registerSession() {
    if (registered) return;
    registered = true;

    const ws = new WebSocket(`${WS_PROTO}://${WS_HOST}/ws/screen/${SCREEN_ID}?api_key=${API_KEY}`);
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
            } else if (data.type === "change_video") {
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

    ws.onclose = () => {
        console.log("[Totem] WS closed — reconnecting in 3s");
        clearInterval(posInterval);
        registered = false;
        screenWs = null;
        setTimeout(registerSession, 3000);
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
