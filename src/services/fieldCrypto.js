// Field-level encryption for sensitive values (passport numbers). AES-256-GCM, random 96-bit IV per value.
//
// Stored form:  v1.<keyId>.<iv>.<tag>.<ciphertext>   (base64url parts)
// - keyId names the key used, so keys can be rotated: add the new key, make it current, re-encrypt old rows
//   (`npm run passports:encrypt -- --rotate`), then retire the old key.
// - Each value is bound to a context string (the traveller's id) as GCM "additional data": a ciphertext copied
//   to another row, or tampered with, fails to decrypt instead of silently returning someone else's passport.
//
// Keys come from the environment (set them from your host's secret manager; never commit them):
//   FIELD_ENCRYPTION_KEYS    "2026a:<base64 32 bytes>[,2025b:<base64 32 bytes>]"   (first is current unless told otherwise)
//   FIELD_ENCRYPTION_KEY_ID  optional: which listed key is current
//   FIELD_ENCRYPTION_KEY     shorthand for a single key (id "k1")
// Generate one:  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
// Missing/invalid keys are a startup failure in production and an error everywhere else (except NODE_ENV=test).
const crypto = require("crypto");

const ID_RE = /^[A-Za-z0-9_-]{1,16}$/;
const b64u = (buf) => buf.toString("base64url");
const unb64u = (s) => Buffer.from(s, "base64url");
const fail = (code, msg) => Object.assign(new Error(msg), { code });

function parseKeys(env) {
  const keys = new Map(); let first = null;
  const add = (id, b64) => {
    if (!ID_RE.test(id)) throw fail("BAD_KEY_CONFIG", `Field encryption key id "${id}" is invalid (use 1-16 letters, digits, - or _).`);
    const buf = Buffer.from(String(b64).trim(), "base64");
    if (buf.length !== 32) throw fail("BAD_KEY_CONFIG", `Field encryption key "${id}" must be 32 bytes (base64).`);
    if (keys.has(id)) throw fail("BAD_KEY_CONFIG", `Field encryption key id "${id}" is listed twice.`);
    keys.set(id, buf); first = first || id;
  };
  if (env.FIELD_ENCRYPTION_KEYS) for (const part of env.FIELD_ENCRYPTION_KEYS.split(",").map((p) => p.trim()).filter(Boolean)) { const i = part.indexOf(":"); if (i < 1) throw fail("BAD_KEY_CONFIG", "FIELD_ENCRYPTION_KEYS entries look like id:base64key."); add(part.slice(0, i), part.slice(i + 1)); }
  else if (env.FIELD_ENCRYPTION_KEY) add("k1", env.FIELD_ENCRYPTION_KEY);
  return { keys, currentId: env.FIELD_ENCRYPTION_KEY_ID || first };
}

function createFieldCrypto({ keys, currentId }) {
  if (!(keys instanceof Map) || keys.size === 0) throw fail("NO_KEY", "No field encryption key is configured.");
  if (!keys.has(currentId)) throw fail("BAD_KEY_CONFIG", `Current field encryption key "${currentId}" is not in the key ring.`);
  const ctx = (aad) => { if (!aad) throw fail("NO_CONTEXT", "A context (e.g. the record id) is required."); return Buffer.from(String(aad)); };
  return {
    currentId,
    encrypt(plain, aad) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv("aes-256-gcm", keys.get(currentId), iv); c.setAAD(ctx(aad));
      const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
      return ["v1", currentId, b64u(iv), b64u(c.getAuthTag()), b64u(ct)].join(".");
    },
    decrypt(blob, aad) {
      const p = typeof blob === "string" ? blob.split(".") : [];
      if (p.length !== 5 || p[0] !== "v1" || !keys.has(p[1])) throw fail("DECRYPT_FAILED", "Cannot decrypt field.");
      try {
        const d = crypto.createDecipheriv("aes-256-gcm", keys.get(p[1]), unb64u(p[2])); d.setAAD(ctx(aad)); d.setAuthTag(unb64u(p[3]));
        return Buffer.concat([d.update(unb64u(p[4])), d.final()]).toString("utf8");
      } catch (_) { throw fail("DECRYPT_FAILED", "Cannot decrypt field."); } // never says why: wrong key, wrong row and tampering look the same
    },
    keyIdOf: (blob) => (typeof blob === "string" && blob.startsWith("v1.") ? blob.split(".")[1] : null),
    isCurrent(blob) { return this.keyIdOf(blob) === currentId; },
  };
}

let cached;
function getFieldCrypto(env = process.env) {
  if (cached && env === process.env) return cached;
  let cfg = parseKeys(env);
  if (cfg.keys.size === 0) {
    if (env.NODE_ENV === "test") cfg = { keys: new Map([["test", crypto.createHash("sha256").update("tapi-test-only-key").digest()]]), currentId: "test" };
    else throw fail("NO_KEY", "FIELD_ENCRYPTION_KEYS is not set. Generate a key with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\" and set FIELD_ENCRYPTION_KEYS=k1:<that value>.");
  }
  const made = createFieldCrypto(cfg);
  if (env === process.env) cached = made;
  return made;
}

module.exports = { createFieldCrypto, getFieldCrypto, parseKeys };
