// Builds the totem URL and <iframe> snippet for embedding a campaign in a site.
// Works in the browser (window.EmbedCode) and in node:test.
(function (root) {
    function clampSize(value, fallback) {
        const n = parseInt(value, 10);
        if (!Number.isFinite(n)) return fallback;
        return Math.min(4000, Math.max(50, n));
    }

    function escapeAttr(s) {
        return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    }

    const trimOrigin = origin => String(origin).replace(/\/+$/, "");

    // Only non-default options go into the URL
    function buildEmbedUrl({ origin, campaign, fit, showQr, listen, pair, qrLink }) {
        const params = new URLSearchParams({ screen: campaign });
        if (fit === "contain") params.set("fit", "contain");
        if (showQr === false) params.set("showqr", "false");
        if (listen === "on" || listen === "off") params.set("listen", listen);
        if (pair) params.set("pair", pair);
        if (qrLink === false) params.set("qrlink", "false");
        return `${trimOrigin(origin)}/static/totem.html?${params}`;
    }

    // Standalone QR iframe that follows the totem iframe on the same page
    function buildQrUrl({ origin, campaign, pair, qrLink }) {
        const params = new URLSearchParams({ screen: campaign });
        if (pair) params.set("pair", pair);
        if (qrLink === false) params.set("qrlink", "false");
        return `${trimOrigin(origin)}/qr?${params}`;
    }

    function buildTotemCode(opts) {
        const width = clampSize(opts.width, 360);
        const height = clampSize(opts.height, 640);
        const src = escapeAttr(buildEmbedUrl(opts));
        const title = escapeAttr(opts.title || "Vídeo com áudio sincronizado");
        const common = `allow="autoplay; fullscreen" loading="lazy" title="${title}"`;

        if (opts.responsive) {
            return `<div style="position:relative;width:100%;aspect-ratio:${width} / ${height};">\n` +
                `  <iframe src="${src}" style="position:absolute;inset:0;width:100%;height:100%;border:0;" ${common}></iframe>\n` +
                `</div>`;
        }
        return `<iframe src="${src}" width="${width}" height="${height}" style="border:0;" ${common}></iframe>`;
    }

    // { video, qr }: with opts.qrSeparate the totem hides its own QR and a /qr
    // iframe shows it elsewhere on the page (both on the same page; same `pair`
    // if set). Without it, qr is null.
    function buildEmbedParts(opts) {
        if (!opts.qrSeparate) return { video: buildTotemCode(opts), qr: null };
        const qrSrc = escapeAttr(buildQrUrl(opts));
        const qrWidth = clampSize(opts.qrWidth, 240);
        const qrHeight = clampSize(opts.qrHeight, 300);
        return {
            video: buildTotemCode({ ...opts, showQr: false }),
            qr: `<iframe src="${qrSrc}" width="${qrWidth}" height="${qrHeight}" style="border:0;" title="QR Code para ouvir o áudio"></iframe>`,
        };
    }

    // Both snippets in one string (single copy/paste)
    function buildEmbedCode(opts) {
        const { video, qr } = buildEmbedParts(opts);
        return qr ? `${video}\n\n<!-- QR Code -->\n${qr}` : video;
    }

    const api = { buildEmbedUrl, buildEmbedCode, buildEmbedParts, buildQrUrl };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    else root.EmbedCode = api;
})(typeof window !== "undefined" ? window : globalThis);
