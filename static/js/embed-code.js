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

    // Only non-default options go into the URL
    function buildEmbedUrl({ origin, campaign, fit, showQr, listen }) {
        const params = new URLSearchParams({ screen: campaign });
        if (fit === "contain") params.set("fit", "contain");
        if (showQr === false) params.set("showqr", "false");
        if (listen === "on" || listen === "off") params.set("listen", listen);
        return `${String(origin).replace(/\/+$/, "")}/static/totem.html?${params}`;
    }

    function buildEmbedCode(opts) {
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

    const api = { buildEmbedUrl, buildEmbedCode };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    else root.EmbedCode = api;
})(typeof window !== "undefined" ? window : globalThis);
