// Phone audio engine shared by mobile.html and mobile_debug.html.
//
// The server's sync gives a cycle (start_time + duration, on the server clock)
// made of items — one per video of the campaign, each with its own audio:
//   items: [{ audio, start, duration }]   (older servers: just `audio`)
// The phone plays, at every moment, the audio of the item the screen is
// showing, from the right offset, and moves to the next audio when the screen
// moves to the next video.
//
// Playback starts on an <audio> element (instant, inside the tap) and switches
// to Web Audio once the files are decoded: sources scheduled on the audio
// clock make item changes exact. Positions in and out are cycle positions,
// the same ones the drift socket uses.
(function (root) {
    // ── Timeline (pure, unit-tested) ─────────────────────
    function timelineFrom(sync) {
        const total = Number(sync.duration) || 0;
        const items = Array.isArray(sync.items) && sync.items.length
            ? sync.items.map(i => ({ audio: i.audio || null, start: Number(i.start) || 0, duration: Number(i.duration) || 0 }))
            : [{ audio: sync.audio || null, start: 0, duration: total }];
        return { items, total: total || items.reduce((t, i) => t + i.duration, 0) || 1 };
    }

    const wrap = (pos, total) => ((pos % total) + total) % total;

    function cyclePosition(serverNow, startTime, total) {
        return wrap(serverNow - startTime, total);
    }

    // Item playing at cycle position `pos` → { index, offset }
    function locate(timeline, pos) {
        const p = wrap(pos, timeline.total);
        for (let i = timeline.items.length - 1; i >= 0; i--) {
            if (p >= timeline.items[i].start) return { index: i, offset: p - timeline.items[i].start };
        }
        return { index: 0, offset: p };
    }

    // Same audio files = no need to download again
    const audioKey = sync => JSON.stringify(timelineFrom(sync).items.map(i => i.audio));

    // ── Player (browser only) ────────────────────────────
    // 1-second silent MP3: keeps the iOS audio session alive
    const SILENT_MP3 = "data:audio/mp3;base64,//OExAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq//OExAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq//OExAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
    const LEAD = 0.05; // seconds between scheduling and the first sample

    function createPlayer({ audioEl, log = () => {} }) {
        let sync = null;
        let timeline = null;
        let serverOffset = 0;   // server clock − local clock (s)
        let playing = false;
        let ctx = null;
        let keepAlive = null;
        let usingWebAudio = false;
        let loadToken = 0;
        const buffers = new Map(); // audio url → AudioBuffer (null = failed)
        let segments = [];         // scheduled items: { index, offset, when, source }
        let nextTimer = null;
        let elementIndex = 0;
        let elementTimer = null;

        const serverNow = () => Date.now() / 1000 + serverOffset;
        const expected = () => (sync ? cyclePosition(serverNow(), sync.start_time, timeline.total) : 0);

        // ── <audio> element ──
        function playElementAt(pos) {
            const { index, offset } = locate(timeline, pos);
            elementIndex = index;
            const url = timeline.items[index].audio;
            if (!url) { audioEl.pause(); return Promise.resolve(); }
            if (audioEl.getAttribute("src") !== url) {
                audioEl.src = url;
                audioEl.load();
            }
            audioEl.loop = timeline.items.length === 1;
            return audioEl.play().then(() => { audioEl.currentTime = offset; });
        }

        // With several items the element follows the screen to the next one
        function watchElement() {
            clearInterval(elementTimer);
            elementTimer = setInterval(() => {
                if (!playing || usingWebAudio || timeline.items.length < 2) return;
                if (locate(timeline, expected()).index !== elementIndex) playElementAt(expected()).catch(() => {});
            }, 250);
        }

        // ── Web Audio ──
        function stopSources() {
            clearTimeout(nextTimer);
            segments.forEach(s => { if (s.source) try { s.source.stop(); } catch (_) {} });
            segments = [];
        }

        function scheduleItem(index, offset, when) {
            const item = timeline.items[index];
            const buffer = item.audio ? buffers.get(item.audio) : null;
            const length = Math.max(item.duration - offset, 0);
            let source = null;
            if (buffer && offset < buffer.duration) {
                source = ctx.createBufferSource();
                source.buffer = buffer;
                source.connect(ctx.destination);
                // An audio longer than its video is cut; a shorter one leaves silence
                source.start(when, offset, Math.min(length, buffer.duration - offset));
            }
            segments.push({ index, offset, when, source });
            if (segments.length > 4) segments.shift();
            // Queue the next item a second ahead, on the audio clock (gapless)
            const nextWhen = when + length;
            const nextIndex = (index + 1) % timeline.items.length;
            nextTimer = setTimeout(() => scheduleItem(nextIndex, 0, nextWhen),
                Math.max((nextWhen - ctx.currentTime - 1) * 1000, 0));
        }

        function webAudioPlayFrom(pos) {
            stopSources();
            const { index, offset } = locate(timeline, pos + LEAD);
            scheduleItem(index, offset, ctx.currentTime + LEAD);
        }

        async function loadBuffers() {
            const token = ++loadToken;
            const urls = [...new Set(timeline.items.map(i => i.audio).filter(Boolean))];
            for (const url of urls) {
                if (buffers.has(url)) continue;
                try {
                    const res = await fetch(url);
                    const data = await res.arrayBuffer();
                    buffers.set(url, await ctx.decodeAudioData(data));
                    log("OK", `Decodificado: ${url.split("/").pop()} (${(data.byteLength / 1024 / 1024).toFixed(1)}MB)`);
                } catch (err) {
                    log("HARD", `WebAudio falhou (${err.message}) — usando <audio>`);
                    return;
                }
                if (token !== loadToken) return; // content changed meanwhile
            }
            if (token !== loadToken || !playing) return;
            webAudioPlayFrom(expected());
            if (!usingWebAudio) {
                usingWebAudio = true;
                // Keep <audio> playing but muted (keeps the iOS session alive).
                // iOS ignores volume = 0, hence muted.
                audioEl.muted = true;
                audioEl.volume = 0;
                log("OK", `Mudou para WebAudio em ${expected().toFixed(2)}s`);
            }
        }

        // ── Public ──
        function setSync(data, receivedAt) {
            const sameAudio = sync && audioKey(sync) === audioKey(data);
            sync = data;
            timeline = timelineFrom(data);
            serverOffset = data.server_time - receivedAt;
            if (!playing) return;
            // New content or timeline while playing: jump to the right place
            if (usingWebAudio && sameAudio) webAudioPlayFrom(expected());
            else {
                if (usingWebAudio) stopSources();
                usingWebAudio = false;
                audioEl.muted = false;
                audioEl.volume = 1;
                playElementAt(expected()).catch(() => {});
                loadBuffers();
            }
        }

        // Must run inside the tap (iOS/Android only allow audio from a gesture)
        function start() {
            if (!keepAlive) {
                keepAlive = new Audio(SILENT_MP3);
                keepAlive.loop = true;
                keepAlive.play().catch(() => log("HARD", "Keep-alive falhou"));
            }
            if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
            if (ctx.state === "suspended") ctx.resume();
            try {
                // A silent buffer inside the tap fully unlocks Web Audio on iOS
                const unlock = ctx.createBufferSource();
                unlock.buffer = ctx.createBuffer(1, 1, 22050);
                unlock.connect(ctx.destination);
                unlock.start(0);
            } catch (_) {
                log("HARD", "Falha ao liberar o áudio");
            }
            return playElementAt(expected()).then(() => {
                playing = true;
                log("OK", `<audio> tocando a partir de ${expected().toFixed(2)}s`);
                watchElement();
                loadBuffers();
            });
        }

        // Cycle position being heard
        function position() {
            if (usingWebAudio && ctx) {
                const now = ctx.currentTime;
                const seg = segments.filter(s => s.when <= now).pop() || segments[0];
                if (!seg) return expected();
                return wrap(timeline.items[seg.index].start + seg.offset + (now - seg.when), timeline.total);
            }
            return wrap(timeline.items[elementIndex].start + audioEl.currentTime, timeline.total);
        }

        function seek(pos) {
            if (usingWebAudio) webAudioPlayFrom(pos);
            else playElementAt(pos).catch(() => {});
        }

        function stop() {
            playing = false;
            loadToken++;
            stopSources();
            clearInterval(elementTimer);
            audioEl.pause();
        }

        return {
            setSync, start, position, seek, stop, expected,
            isPlaying: () => playing,
            isWebAudio: () => usingWebAudio,
            itemIndex: () => locate(timeline, position()).index,
            itemCount: () => (timeline ? timeline.items.length : 0),
        };
    }

    const api = { timelineFrom, cyclePosition, locate, createPlayer };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    else root.SyncPlayer = api;
})(typeof window !== "undefined" ? window : globalThis);
