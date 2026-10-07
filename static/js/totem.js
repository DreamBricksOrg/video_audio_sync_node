// ── Config ─────────────────────────────────────────────
const urlParams = new URLSearchParams(window.location.search);
const SCREEN_ID = urlParams.get('screen') || "totem1";
// ?showqr=false|0|no|off hides the QR overlay (default: shown)
const SHOW_QR   = !["false", "0", "no", "off"].includes((urlParams.get('showqr') || "").toLowerCase());
// ?qrlink=false keeps the QR but not clickable (touch-screen totems: a tap
// must not open a new tab over the video)
const QR_LINK   = !["false", "0", "no", "off"].includes((urlParams.get('qrlink') || "").toLowerCase());
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
const WS_HOST   = location.host;
const WS_PROTO  = location.protocol === "https:" ? "wss" : "ws";
// One instance per page load: every screen/iframe gets its own sync session.
// (crypto.randomUUID only exists on https/localhost, hence the fallback.)
const INSTANCE_ID = (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const MOBILE_URL = `${location.protocol}//${location.host}/static/mobile.html` +
    `?screen=${encodeURIComponent(SCREEN_ID)}&instance=${INSTANCE_ID}`;

// Two video elements take turns: while one plays, the other loads the next
// video of the playlist, so the switch has no gap
const videos    = [document.getElementById("video"), document.getElementById("video2")];
const idleScreen = document.getElementById("idleScreen");
const qrOverlay = document.querySelector(".qr-overlay");

let active = 0;            // which element of `videos` is showing
const activeVideo = () => videos[active];

// ── Content (from the server's change_video) ──────────
let playlist   = [];       // [{ video, url, audio }]
let durations  = [];       // seconds, per item
let itemIndex  = 0;        // item showing
let contentKey = null;
let idle       = false;    // nothing on air: black screen with logo
let loadToken  = 0;

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
    if (QR_LINK) qrOverlay.href = MOBILE_URL;
} else {
    qrOverlay.remove();
}

// ── Separate QR iframe (/qr?screen=…) on the same page ──
// Publishes this instance so a QR iframe follows it (?pair= links one QR to
// one totem when a page has several totems of the same campaign).
const qrPublisher = window.BroadcastChannel && window.QrChannel
    ? QrChannel.createQrPublisher({
        campaign: SCREEN_ID, pair: urlParams.get('pair') || "", instance: INSTANCE_ID, mobileUrl: MOBILE_URL,
    })
    : null;
window.addEventListener("pagehide", () => qrPublisher && qrPublisher.close());

// ── QR hide/show (hidden for N video loops, and while nothing is on air) ──
// Runs even with showqr=false, so a separate QR iframe hides/shows too
function updateQr() {
    const hidden = idle || loopsToHide > 0;
    if (SHOW_QR) qrOverlay.classList.toggle("hidden", hidden);
    if (qrPublisher) qrPublisher.setHidden(hidden);
}

function hideQrForLoops(count) {
    loopsToHide = count;
    updateQr();
    console.log(`[Totem] QR hidden for ${count} loops`);
}

// A video ended (single video looping, or the playlist moving on)
function onVideoLoop() {
    if (loopsToHide <= 0) return;
    loopsToHide--;
    console.log(`[Totem] Loop — ${loopsToHide} remaining`);
    if (loopsToHide <= 0) {
        updateQr();
        console.log("[Totem] QR visible again");
    }
}

// A single video loops natively: detect the wrap via 'seeked' to ~0
videos.forEach(v => v.addEventListener("seeked", () => {
    if (v === activeVideo() && v.loop && v.currentTime < 1) onVideoLoop();
}));

// ── Timeline: position in the whole cycle (all videos) ──
const itemStart = i => durations.slice(0, i).reduce((a, b) => a + b, 0);
const cycleLength = () => durations.reduce((a, b) => a + b, 0) || activeVideo().duration || 30;
const cyclePosition = () => (playlist.length ? itemStart(itemIndex) : 0) + (activeVideo().currentTime || 0);

// Length of a video without playing it
function probeDuration(url) {
    return new Promise(resolve => {
        const probe = document.createElement("video");
        probe.muted = true;
        probe.preload = "metadata";
        const done = d => {
            clearTimeout(timer);
            probe.removeAttribute("src");
            probe.load();
            resolve(Number.isFinite(d) && d > 0 ? d : 30);
        };
        const timer = setTimeout(() => done(NaN), 15000);
        probe.onloadedmetadata = () => done(probe.duration);
        probe.onerror = () => done(NaN);
        probe.src = url;
    });
}

function setSource(v, url) {
    if (v.getAttribute("src") !== url) {
        v.src = url;
        v.load();
    }
}

function show(v) {
    videos.forEach(other => other.classList.toggle("standby", other !== v));
}

// The other element loads the next video, paused at 0
function prepareNext() {
    if (playlist.length < 2) return;
    const next = videos[1 - active];
    next.loop = false;
    next.pause();
    setSource(next, playlist[(itemIndex + 1) % playlist.length].url);
    try { next.currentTime = 0; } catch (_) {}
}

function advance() {
    const prev = activeVideo();
    active = 1 - active;
    itemIndex = (itemIndex + 1) % playlist.length;
    const v = activeVideo();
    v.play().catch(err => console.error("[Totem] Play failed", err));
    show(v);
    prev.pause();
    switchListenAudio(playlist[itemIndex].audio);
    onVideoLoop();
    sendPosition();
    prepareNext();
}

videos.forEach(v => v.addEventListener("ended", () => {
    if (v === activeVideo() && playlist.length > 1) advance();
}));

function setIdle(on) {
    idle = on;
    idleScreen.hidden = !on;
    if (on) {
        loadToken++;
        playlist = [];
        durations = [];
        videos.forEach(v => { v.pause(); v.removeAttribute("src"); v.load(); });
        setAudioUrl(null);
    }
    updateQr();
}

async function loadPlaylist(list) {
    const token = ++loadToken;
    console.log(`[Totem] Loading ${list.length} video(s): ${list.map(i => i.video).join(", ")}`);
    const lengths = await Promise.all(list.map(i => probeDuration(i.url)));
    if (token !== loadToken) return; // newer content arrived meanwhile

    playlist = list;
    durations = lengths;
    itemIndex = 0;
    const v = activeVideo();
    v.loop = list.length === 1;
    setSource(v, list[0].url);
    try { v.currentTime = 0; } catch (_) {}
    v.play().catch(err => console.error("[Totem] Play failed", err));
    show(v);
    setAudioUrl(list[0].audio);
    prepareNext();
    sendRegistration(); // phones get the new timeline
}

function applyContent(data) {
    if (data.key && data.key === contentKey) return; // already showing this
    contentKey = data.key || null;
    const list = data.playlist || (data.filename ? [{ video: data.filename, url: data.url, audio: data.audio }] : []);
    if (data.idle || !list.length) {
        console.log("[Totem] Nothing on air");
        setIdle(true);
        return;
    }
    setIdle(false);
    loadPlaylist(list.map(i => ({ ...i, url: i.url || `/media/${encodeURIComponent(i.video)}` })));
}

// ── "Ouvir aqui": play the campaign audio on this device ───
const listenBtn  = document.getElementById("listenBtn");
const localAudio = new Audio();
localAudio.preload = "auto";
let audioUrl  = null;
let listening = false;
let audioSyncTimer = null;

// New content: a different audio stops listening (the visitor taps again)
function setAudioUrl(url) {
    const changed = (url || null) !== audioUrl;
    audioUrl = url || null;
    listenBtn.hidden = !(LISTEN_MODE && audioUrl);
    if (changed && listening) stopListening();
}

// Next video of the playlist: keep listening, with that video's audio
function switchListenAudio(url) {
    audioUrl = url || null;
    if (!listening) {
        listenBtn.hidden = !(LISTEN_MODE && audioUrl);
        return;
    }
    if (!audioUrl) {
        localAudio.pause();
        return;
    }
    localAudio.src = audioUrl;
    localAudio.currentTime = 0;
    localAudio.play().catch(err => console.error("[Totem] Local audio failed", err));
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
    localAudio.currentTime = activeVideo().currentTime;
    listening = true;
    updateListenBtn();
    // Keep the audio on the video's timeline (loops, stalls, seeks) and
    // playing whenever the video is playing
    audioSyncTimer = setInterval(() => {
        const v = activeVideo();
        if (v.paused || !audioUrl) return;
        if (LocalAudio.shouldResync(localAudio.currentTime, v.currentTime, v.duration || 0)) {
            localAudio.currentTime = v.currentTime;
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
// A paused standby video (next in the playlist) doesn't count.
videos.forEach(v => {
    ["pause", "waiting"].forEach(evt => v.addEventListener(evt, () => {
        if (listening && v === activeVideo()) localAudio.pause();
    }));
    v.addEventListener("playing", () => {
        if (!listening || v !== activeVideo() || !audioUrl) return;
        localAudio.currentTime = v.currentTime;
        localAudio.play().catch(err => console.error("[Totem] Local audio resume failed", err));
    });
});

// Site embedding this screen, for the admin statistics (no path or query:
// just "loja.com.br"). Empty when the page is opened directly.
const EMBED_SITE = (() => {
    if (window.top === window) return "";
    try {
        const parent = (location.ancestorOrigins && location.ancestorOrigins[0]) || document.referrer;
        return parent ? new URL(parent).hostname : "?";
    } catch (_) {
        return "?";
    }
})();

// ── Register session (WS stays open for notifications) ─
let screenWs = null;

// Position in the cycle — the server computes start_time with its own clock.
// `items` = each video's length, so phones switch audio with the video.
function sendRegistration() {
    if (!screenWs || screenWs.readyState !== 1) return;
    screenWs.send(JSON.stringify({
        current_time: cyclePosition(),
        duration: cycleLength(),
        ...(playlist.length > 1 ? { items: durations } : {}),
        mode: "sync",
        drift_enabled: true,
        site: EMBED_SITE,
    }));
    console.log(`[Totem] Session registered — ${cycleLength().toFixed(2)}s, pos: ${cyclePosition().toFixed(2)}s`);
}

function sendPosition() {
    if (screenWs && screenWs.readyState === 1 && playlist.length) {
        screenWs.send(JSON.stringify({ type: "position_update", current_time: cyclePosition() }));
    }
}

function registerSession() {
    if (registered) return;
    registered = true;

    // Reconnects reuse INSTANCE_ID, so phones already synced keep their session.
    // No API key: the page is public, so a key here would be visible to anyone —
    // abuse is handled server-side (screens per IP / per campaign limits).
    const ws = new WebSocket(`${WS_PROTO}://${WS_HOST}/ws/screen/${SCREEN_ID}?instance=${INSTANCE_ID}`);
    screenWs = ws;

    ws.onopen = sendRegistration;

    // Periodically send position updates so server recalculates start_time
    const posInterval = setInterval(() => {
        if (ws.readyState === 1) sendPosition();
        else clearInterval(posInterval);
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
                applyContent(data);
            }
        } catch (err) {
            console.error("[Totem] Bad message", err);
        }
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

registerSession();
