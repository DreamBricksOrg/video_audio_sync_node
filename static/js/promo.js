// ── Promo box (text + links), configured per totem in the admin ──────────
// Shared by mobile.html and mobile_debug.html. The config arrives in the
// "sync" message as `promo`; built with DOM APIs (no innerHTML) since the
// values are admin-provided.

// App button: pick the store link for this device, falling back to the others
function appUrlForDevice(app) {
    const ua = navigator.userAgent || navigator.vendor || "";
    if (/iPad|iPhone|iPod/.test(ua) && app.ios) return app.ios;
    if (/android/i.test(ua) && app.android) return app.android;
    return app.fallback || app.ios || app.android || "";
}

function promoButton(className, icon, label) {
    const a = document.createElement("a");
    a.className = `btn ${className}`;
    const i = document.createElement("i");
    i.setAttribute("data-lucide", icon);
    a.append(i, document.createTextNode(` ${label}`));
    return a;
}

function renderPromo(promo) {
    const box = document.getElementById("promoBox");
    const textEl = document.getElementById("promoText");
    const buttonsEl = document.getElementById("promoButtons");
    if (!box || !promo) return;

    buttonsEl.innerHTML = "";

    const app = promo.app || {};
    const appUrl = appUrlForDevice(app);
    if (appUrl) {
        const btn = promoButton("btn-primary btn-wide", "smartphone", app.label || "Baixar App");
        btn.href = appUrl;
        buttonsEl.appendChild(btn);
    }

    (promo.links || []).forEach(link => {
        const btn = promoButton("btn-secondary", link.icon || "link", link.label);
        btn.href = link.url;
        btn.target = "_blank";
        btn.rel = "noopener";
        buttonsEl.appendChild(btn);
    });

    textEl.textContent = promo.text || "";
    textEl.classList.toggle("hidden", !promo.text);
    buttonsEl.classList.toggle("hidden", !buttonsEl.children.length);
    box.classList.toggle("hidden", !promo.text && !buttonsEl.children.length);

    if (window.lucide) lucide.createIcons();
}
