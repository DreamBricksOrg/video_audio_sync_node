// Pairs a totem iframe with a separate QR iframe on the same page, without the
// server: the totem publishes its instance on a BroadcastChannel and the QR
// page follows it (new instance on reload, hidden while a phone is connected).
// Works in the browser (window.QrChannel) and in node:test.
(function (root) {
    function channelName(campaign, pair) {
        return `audiosync-qr:${campaign}${pair ? `:${pair}` : ""}`;
    }

    // Totem side
    function createQrPublisher({ campaign, pair, instance, mobileUrl }) {
        const ch = new BroadcastChannel(channelName(campaign, pair));
        let hidden = false;
        const announce = () => ch.postMessage({ type: "instance", instance, mobileUrl, hidden });

        // A QR iframe that loads after the totem asks for the current state
        ch.onmessage = e => { if (e.data && e.data.type === "hello") announce(); };
        announce();

        return {
            setHidden(value) {
                if (hidden === !!value) return;
                hidden = !!value;
                announce();
            },
            close() {
                ch.postMessage({ type: "gone", instance });
                ch.close();
            },
        };
    }

    // QR side: onChange({ instance, mobileUrl, hidden }) or onChange(null) when the totem left
    function createQrSubscriber({ campaign, pair, onChange }) {
        const ch = new BroadcastChannel(channelName(campaign, pair));
        let current = null;

        ch.onmessage = e => {
            const msg = e.data || {};
            if (msg.type === "instance") {
                const next = { instance: msg.instance, mobileUrl: msg.mobileUrl, hidden: !!msg.hidden };
                if (current && current.instance === next.instance &&
                    current.mobileUrl === next.mobileUrl && current.hidden === next.hidden) return;
                current = next;
                onChange(current);
            } else if (msg.type === "gone" && current && msg.instance === current.instance) {
                current = null;
                onChange(null);
            }
        };
        ch.postMessage({ type: "hello" }); // the totem may already be running

        return { close: () => ch.close() };
    }

    const api = { channelName, createQrPublisher, createQrSubscriber };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    else root.QrChannel = api;
})(typeof window !== "undefined" ? window : globalThis);
