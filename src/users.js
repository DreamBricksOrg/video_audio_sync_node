/**
 * Admin users. The .env account (ADMIN_USER / ADMIN_PASSWORD) is the main
 * admin: always there, changed only in .env — the way back in if every other
 * login is lost. Other users live in users.json (next to totems.json, or in
 * the bucket in S3 mode, shared by every server), with scrypt password hashes.
 *
 * Roles: "admin" (everything) and "editor" (campaigns, media, links and
 * statistics; not users, the activity log or ending other sessions).
 */
const crypto = require("crypto");
const path = require("path");
const { ADMIN_USER, ADMIN_PASSWORD, SESSION_SECRET, TOTEMS_FILE, DEFAULT_USER_PASSWORD } = require("./settings");
const { createFileConfigStore, createS3ConfigStore, isConfigConflict } = require("../lib/config-store");
const { createSyncedDoc } = require("../lib/synced-doc");
const { hashPassword, verifyPassword } = require("../lib/passwords");
const { HttpError } = require("./http-error");
const { log } = require("./log");

const ROLES = ["admin", "editor"];
const NAME_RE = /^[A-Za-z0-9._-]{2,40}$/;
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const MIN_PASSWORD = 8;

// Logins are case-insensitive for e-mails (people type them in any case)
const loginKey = name => {
  const s = String(name || "").trim();
  return s.includes("@") ? s.toLowerCase() : s;
};
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function createUsers({ storage }) {
  const NAME = "users.json";
  const store = storage.enabled
    ? createS3ConfigStore({ storage, name: NAME })
    : createFileConfigStore({ file: process.env.USERS_FILE || path.join(path.dirname(TOTEMS_FILE), NAME) });
  const doc = createSyncedDoc({ store, isConflict: isConfigConflict });

  const sign = value => crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("base64url").slice(0, 22);
  // Some hash to check when the name doesn't exist, so timing doesn't tell
  const dummyHash = hashPassword(crypto.randomBytes(16).toString("hex"));

  const mainEnabled = () => !!(ADMIN_USER && ADMIN_PASSWORD);

  // { name, displayName, role, main, tag } — `tag` changes when the password
  // does, which ends that user's sessions (they record the tag at login)
  function find(login) {
    const name = loginKey(login);
    if (mainEnabled() && name === ADMIN_USER) {
      return { name, displayName: name, role: "admin", main: true, tag: sign(`${ADMIN_USER}:${ADMIN_PASSWORD}`) };
    }
    const u = has(doc.get(), name) ? doc.get()[name] : null;
    return u ? { name, displayName: u.displayName || name, role: u.role, main: false, tag: sign(`${name}:${u.hash}`) } : null;
  }

  // Is this login taken? (re-reads the shared file first, for other servers)
  async function exists(login) {
    const name = loginKey(login);
    if (mainEnabled() && name === ADMIN_USER) return true;
    if (store.remote && !has(doc.get(), name)) await refresh();
    return has(doc.get(), name);
  }

  // The user when name + password are right, else null
  async function verify(login, password) {
    const name = loginKey(login);
    const safeEqual = (a, b) => crypto.timingSafeEqual(
      crypto.createHash("sha256").update(String(a)).digest(),
      crypto.createHash("sha256").update(String(b)).digest(),
    );
    if (mainEnabled() && safeEqual(name, ADMIN_USER)) {
      return safeEqual(password, ADMIN_PASSWORD) ? find(ADMIN_USER) : null;
    }
    // Maybe created on another server a moment ago
    if (store.remote && !Object.prototype.hasOwnProperty.call(doc.get(), name)) await refresh();
    const u = Object.prototype.hasOwnProperty.call(doc.get(), name) ? doc.get()[name] : null;
    const ok = await verifyPassword(password, u ? u.hash : await dummyHash);
    return u && ok ? find(name) : null;
  }

  function list() {
    const others = Object.entries(doc.get())
      .map(([name, u]) => ({ name, displayName: u.displayName || "", role: u.role, main: false, created: u.created, updated: u.updated }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return mainEnabled() ? [{ name: ADMIN_USER, role: "admin", main: true }, ...others] : others;
  }

  function checkRole(role) {
    if (!ROLES.includes(role)) throw new HttpError(400, "Papel inválido: escolha Admin ou Editor");
  }
  function checkPassword(password) {
    if (typeof password !== "string" || password.length < MIN_PASSWORD) {
      throw new HttpError(400, `A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres`);
    }
  }
  function checkEditable(name) {
    if (mainEnabled() && name === ADMIN_USER) {
      throw new HttpError(400, "A conta principal é definida no .env (ADMIN_USER / ADMIN_PASSWORD) e não pode ser alterada aqui");
    }
  }

  // Self sign-up rule: 8+ characters with letters and numbers, not the invite
  function checkOwnPassword(password) {
    if (typeof password !== "string" || password.length < MIN_PASSWORD || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      throw new HttpError(400, `A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres, com letras e números`);
    }
    if (DEFAULT_USER_PASSWORD && password === DEFAULT_USER_PASSWORD) {
      throw new HttpError(400, "Escolha uma senha sua, diferente da senha de convite");
    }
  }

  // An @domain e-mail signing itself up (see auth.js): always an Editor
  async function createSelf({ email, displayName, password }) {
    const name = loginKey(email);
    const display = String(displayName || "").trim().replace(/\s+/g, " ");
    if (!EMAIL_RE.test(name)) throw new HttpError(400, "E-mail inválido");
    if (display.length < 2 || display.length > 60) throw new HttpError(400, "Digite seu nome (2 a 60 caracteres)");
    checkOwnPassword(password);
    const hash = await hashPassword(password);
    const now = new Date().toISOString();
    await doc.mutate(all => {
      if (has(all, name)) throw new HttpError(409, "Este e-mail já tem um usuário. Entre com a sua senha.");
      all[name] = { role: "editor", displayName: display, email: name, hash, created: now, updated: now, self: true };
    });
    log.info("Users", `${name} signed up (editor)`);
    return find(name);
  }

  async function create({ name, password, role }) {
    if (!NAME_RE.test(name || "")) throw new HttpError(400, "O nome deve ter de 2 a 40 letras, números, ponto, - ou _");
    checkRole(role);
    checkPassword(password);
    if (mainEnabled() && name === ADMIN_USER) throw new HttpError(409, `O usuário "${name}" já existe`);
    const hash = await hashPassword(password);
    const now = new Date().toISOString();
    await doc.mutate(all => {
      if (Object.prototype.hasOwnProperty.call(all, name)) throw new HttpError(409, `O usuário "${name}" já existe`);
      all[name] = { role, hash, created: now, updated: now };
    });
    log.info("Users", `Created ${name} (${role})`);
  }

  async function update(name, { role, password }) {
    checkEditable(name);
    if (role !== undefined) checkRole(role);
    if (password !== undefined) checkPassword(password);
    const hash = password !== undefined ? await hashPassword(password) : null;
    await doc.mutate(all => {
      if (!Object.prototype.hasOwnProperty.call(all, name)) throw new HttpError(404, "Usuário não encontrado");
      all[name] = {
        ...all[name],
        ...(role !== undefined ? { role } : {}),
        ...(hash ? { hash } : {}),
        updated: new Date().toISOString(),
      };
    });
    log.info("Users", `Updated ${name}${role ? ` (role ${role})` : ""}${hash ? " (new password)" : ""}`);
  }

  async function remove(name, byUser) {
    checkEditable(name);
    if (name === byUser) throw new HttpError(400, "Você não pode excluir o seu próprio usuário");
    await doc.mutate(all => {
      if (!Object.prototype.hasOwnProperty.call(all, name)) throw new HttpError(404, "Usuário não encontrado");
      delete all[name];
    });
    log.info("Users", `Deleted ${name}`);
  }

  let refreshError = null;
  async function refresh() {
    try {
      await doc.refresh();
      refreshError = null;
    } catch (e) {
      (refreshError ? log.warn : log.error)("Users", "Refresh failed:", e);
      refreshError = e.message || String(e);
    }
  }

  return {
    load: () => doc.load(), refresh, find, exists, verify, list, create, createSelf, update, remove,
    any: () => mainEnabled() || Object.keys(doc.get()).length > 0,
    status: () => (refreshError ? { ok: false, error: refreshError } : { ok: true }),
  };
}

module.exports = { createUsers, ROLES };
