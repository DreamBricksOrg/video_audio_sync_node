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
