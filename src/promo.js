/**
 * Text and links of the phone page (per campaign): defaults, allowed icons and
 * validation of what the admin sends.
 */
// Used for totems that never had their links edited in the admin.
const DEFAULT_PROMO = {
  text: "Enquanto escuta a propaganda, aproveite para saber mais sobre a 99food",
  app: {
    label: "Baixar App",
    ios: "https://apps.apple.com/br/app/99-corridas-food-pay/id553663691",
    android: "https://play.google.com/store/apps/details?id=com.taxis99",
    fallback: "https://99app.com/99food/",
  },
  links: [
    { label: "Site", url: "https://99app.com/99food/", icon: "utensils" },
    { label: "Inst", url: "https://instagram.com/99brasil", icon: "camera" },
    { label: "X", url: "https://x.com/voude99", icon: "at-sign" },
  ],
};

// Lucide icon names the admin can pick for a link button
const PROMO_ICONS = [
  "link", "globe", "utensils", "shopping-bag", "camera", "at-sign", "message-circle",
  "play", "music", "ticket", "gift", "map-pin", "phone", "mail", "star", "heart",
];
const PROMO_MAX_LINKS = 6;

// Validates admin input; returns { promo } or { error }. Only http(s) URLs are
// accepted, since they end up as links on the public mobile page.
function sanitizePromo(input) {
  if (!input || typeof input !== "object") return { error: "Dados inválidos" };

  const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const url = (v, field) => {
    const s = str(v, 2000);
    if (!s) return "";
    try {
      const u = new URL(s);
      if (u.protocol === "http:" || u.protocol === "https:") return u.href;
    } catch (_) {}
    throw new Error(`${field}: digite o endereço completo, começando com https://`);
  };

  try {
    const app = input.app || {};
    const promo = {
      text: str(input.text, 300),
      app: {
        label: str(app.label, 30) || "Baixar App",
        ios: url(app.ios, "App Store (iPhone)"),
        android: url(app.android, "Google Play (Android)"),
        fallback: url(app.fallback, "Outros aparelhos"),
      },
      links: [],
    };

    const links = Array.isArray(input.links) ? input.links : [];
    if (links.length > PROMO_MAX_LINKS) throw new Error(`No máximo ${PROMO_MAX_LINKS} links`);
    links.forEach((l, i) => {
      const label = str(l && l.label, 30);
      const href = url(l && l.url, `Link ${i + 1}`);
      if (!label || !href) throw new Error(`Link ${i + 1}: texto e endereço são obrigatórios`);
      const icon = PROMO_ICONS.includes(l.icon) ? l.icon : "link";
      promo.links.push({ label, url: href, icon });
    });

    return { promo };
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = { DEFAULT_PROMO, PROMO_ICONS, PROMO_MAX_LINKS, sanitizePromo };
