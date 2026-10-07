// Standalone QR iframe: /qr?screen=<campaign>[&pair=<id>]
// Shows the QR of the totem iframe on the same page and follows it: a new
// instance when the totem reloads, "connected" while a phone is listening.
const params = new URLSearchParams(location.search);
const SCREEN_ID = params.get("screen") || "totem1";
const PAIR = params.get("pair") || "";
// ?qrlink=false: QR not clickable (touch screens)
const QR_LINK = !["false", "0", "no", "off"].includes((params.get("qrlink") || "").toLowerCase());

const qrLink = document.getElementById("qrLink");
const qrWrapper = document.getElementById("qrWrapper");
let qr = null;
let shownUrl = null;

function render(state) {
    if (!state) {
        // Totem not open (yet) or reloading
        document.body.dataset.state = "waiting";
        qrLink.removeAttribute("href");
        return;
    }
    if (state.mobileUrl !== shownUrl) {
        if (!qr) {
            // Rendered large and scaled by CSS so it stays sharp at any frame size
            qr = new QRCode(qrWrapper, {
                text: state.mobileUrl, width: 480, height: 480,
                colorDark: "#034a5d", colorLight: "#ffffff", // --db-blue-900 on white
                correctLevel: QRCode.CorrectLevel.H,
            });
        } else {
            qr.clear();
            qr.makeCode(state.mobileUrl);
        }
        shownUrl = state.mobileUrl;
        console.log(`[QR] Following ${SCREEN_ID}/${state.instance}`);
    }
    if (QR_LINK) qrLink.href = state.mobileUrl; // same page the QR points to, in a new tab
    document.body.dataset.state = state.hidden ? "connected" : "ready";
}

if (window.BroadcastChannel) {
    QrChannel.createQrSubscriber({ campaign: SCREEN_ID, pair: PAIR, onChange: render });
} else {
    // Very old browsers: no way to pair with the totem iframe
    document.querySelector(".state-waiting").textContent = "Navegador sem suporte ao QR separado.";
}
