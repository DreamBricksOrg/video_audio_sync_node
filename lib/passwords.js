/**
 * Password hashing with scrypt (Node built-in). Stored as
 *   scrypt$N$r$p$salt$hash   (salt and hash in base64url)
 * so the cost can be raised later without breaking existing users.
 */
const crypto = require("crypto");
const { promisify } = require("util");

const scrypt = promisify(crypto.scrypt);
const COST = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 32;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(String(password), salt, KEY_LENGTH, COST);
  return ["scrypt", COST.N, COST.r, COST.p, salt.toString("base64url"), hash.toString("base64url")].join("$");
}

async function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, "base64url");
  if (!salt || expected.length !== KEY_LENGTH) return false;
  try {
    const actual = await scrypt(String(password), Buffer.from(salt, "base64url"), KEY_LENGTH, { N: +N, r: +r, p: +p });
    return crypto.timingSafeEqual(actual, expected);
  } catch (_) {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword };
