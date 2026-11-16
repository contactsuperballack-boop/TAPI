// Password hashing with Node's built-in scrypt (no native dependency). Format:
//   scrypt$N$r$p$<salt b64>$<hash b64>   so parameters can be raised later without a migration.
const crypto = require("crypto");
const { promisify } = require("util");
const scrypt = promisify(crypto.scrypt);

const PARAMS = { N: 2 ** 15, r: 8, p: 1, keylen: 64 };
const MAXMEM = 128 * PARAMS.N * PARAMS.r * 2;

async function hashPassword(password, params = PARAMS) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, params.keylen, { N: params.N, r: params.r, p: params.p, maxmem: MAXMEM * 4 });
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

async function verifyPassword(password, stored) {
  const parts = typeof stored === "string" ? stored.split("$") : [];
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length, { N: +N, r: +r, p: +p, maxmem: MAXMEM * 4 });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

const COMMON = new Set(["password", "password1", "password123", "1234567890", "qwertyuiop", "iloveyou12", "letmein123", "admin12345", "welcome123", "changeme123", "0123456789", "11111111111"]);

// Returns an error message, or null if acceptable. Length over composition rules (NIST 800-63B direction).
function passwordProblem(password, { email, fullName } = {}) {
  if (typeof password !== "string") return "Password is required.";
  if (password.length < 10) return "Use at least 10 characters.";
  if (password.length > 128) return "Use 128 characters or fewer.";
  const low = password.toLowerCase();
  if (COMMON.has(low) || /^(.)\1+$/.test(password)) return "That password is too easy to guess. Try a longer phrase.";
  if (email && low.includes(String(email).split("@")[0].toLowerCase()) && String(email).split("@")[0].length >= 4) return "Do not use your email address in your password.";
  if (fullName && fullName.split(/\s+/).some((w) => w.length >= 5 && low.includes(w.toLowerCase()))) return "Do not use your name in your password.";
  return null;
}

module.exports = { hashPassword, verifyPassword, passwordProblem, PARAMS };
