// API-key lifecycle: secure generation, hashed storage, prefix for
// identification, expiration, revocation, last-used tracking, and listing
// without ever exposing the secret again after creation.
const crypto = require("crypto");
const db = require("../db");

const KEY_BYTE_LENGTH = 32; // 256 bits of entropy
const PREFIX_VISIBLE_CHARS = 12; // how much of the raw key is safe to store/display for identification

function hashKey(rawKey) {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

/**
 * Generates a new raw API key. Format: tapi_<env>_<random>.
 * The prefix (tapi_<env>_ + first PREFIX_VISIBLE_CHARS of the random part)
 * is stored in plaintext for identification in listings — this is
 * deliberately not enough entropy to reconstruct or brute-force the key.
 */
function generateApiKey(env = "live") {
  const random = crypto.randomBytes(KEY_BYTE_LENGTH).toString("base64url");
  const rawKey = `tapi_${env}_${random}`;
  const keyPrefix = rawKey.slice(0, `tapi_${env}_`.length + PREFIX_VISIBLE_CHARS);
  return { rawKey, keyPrefix, keyHash: hashKey(rawKey) };
}

const ApiKeys = {
  /**
   * @param {object} opts
   * @param {string} opts.agencyId
   * @param {string} [opts.label]
   * @param {number} [opts.expiresInDays] - if omitted, key never expires
   * @param {string} [opts.env] - 'live' | 'test'
   */
  async create({ agencyId, label, expiresInDays, env = "live" }) {
    const { rawKey, keyPrefix, keyHash } = generateApiKey(env);
    const expiresAt = expiresInDays
      ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
      : null;

    const { rows } = await db.query(
      `INSERT INTO api_clients (agency_id, key_hash, key_prefix, label, status, expires_at)
       VALUES ($1,$2,$3,$4,'active',$5)
       RETURNING id, agency_id, key_prefix, label, status, expires_at, last_used_at, created_at`,
      [agencyId, keyHash, keyPrefix, label || null, expiresAt]
    );

    // rawKey is returned exactly once, here, and never again — it is not
    // recoverable from the stored hash.
    return { rawKey, client: toClientView(rows[0]) };
  },

  /** List keys for an agency. Never returns key_hash or the raw key. */
  async listForAgency(agencyId) {
    const { rows } = await db.query(
      `SELECT id, agency_id, key_prefix, label, status, expires_at, last_used_at, created_at, revoked_at
       FROM api_clients WHERE agency_id = $1 ORDER BY created_at DESC`,
      [agencyId]
    );
    return rows.map(toClientView);
  },

  async revoke(agencyId, clientId) {
    const { rows } = await db.query(
      `UPDATE api_clients SET status='revoked', revoked_at=now()
       WHERE id=$1 AND agency_id=$2 AND status='active'
       RETURNING id, agency_id, key_prefix, label, status, expires_at, last_used_at, created_at, revoked_at`,
      [clientId, agencyId]
    );
    return rows[0] ? toClientView(rows[0]) : null;
  },

  /** Used by auth middleware. Returns the row (including status/expiry) for a given raw key's hash, or null. */
  async findByHash(keyHash) {
    const { rows } = await db.query(
      `SELECT id, agency_id, key_prefix, status, expires_at, last_used_at FROM api_clients WHERE key_hash = $1`,
      [keyHash]
    );
    return rows[0] || null;
  },

  /**
   * Fire-and-forget-safe last-used touch. Deliberately throttled to avoid a
   * write on every single request: only updates if the last touch was more
   * than 60s ago (or never). Good enough for "when was this key last used"
   * without hammering the row on high-traffic keys.
   */
  async touchLastUsed(clientId) {
    await db.query(
      `UPDATE api_clients SET last_used_at = now()
       WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds')`,
      [clientId]
    );
  },
};

function toClientView(row) {
  const now = new Date();
  const expired = row.expires_at ? new Date(row.expires_at) < now : false;
  return {
    id: row.id,
    agencyId: row.agency_id,
    keyPrefix: row.key_prefix,
    label: row.label,
    status: row.status, // 'active' | 'revoked' — as stored
    isActive: row.status === "active" && !expired, // derived: active AND not expired
    isExpired: expired,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at || null,
  };
}

module.exports = { ApiKeys, generateApiKey, hashKey };
