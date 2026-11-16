const db = require("../db");
const { ApiError } = require("../domain/errors");

const USER_COLS = "id, email, password_hash, full_name, email_verified_at, status, failed_logins, locked_until";
const isUnique = (e) => e && e.code === "23505";

const Identity = {
  async findUserByEmail(email) { const { rows } = await db.query(`SELECT ${USER_COLS} FROM users WHERE lower(email)=lower($1)`, [email]); return rows[0] || null; },
  async findUserById(id) { const { rows } = await db.query(`SELECT ${USER_COLS} FROM users WHERE id=$1`, [id]); return rows[0] || null; },

  // Direct sign-up: a user + a customer/traveler record in the house agency + a traveller membership, atomically.
  // The user row goes first so a duplicate email fails before anything else is written.
  async createTravellerAccount({ email, passwordHash, firstName, lastName }) {
    try {
      return await db.withTransaction(async (q) => {
        const house = (await q.query(`SELECT id FROM agencies WHERE kind='house'`)).rows[0];
        if (!house) throw new ApiError("INTERNAL_ERROR", 500, "Internal error", "House agency is missing; run migrations.");
        const u = (await q.query(`INSERT INTO users (email, password_hash, full_name) VALUES ($1,$2,$3) RETURNING ${USER_COLS}`, [email, passwordHash, `${firstName} ${lastName}`])).rows[0];
        const c = (await q.query(`INSERT INTO customers (agency_id, full_name, email) VALUES ($1,$2,$3) RETURNING id`, [house.id, `${firstName} ${lastName}`, email])).rows[0];
        const t = (await q.query(`INSERT INTO travelers (agency_id, customer_id, first_name, last_name) VALUES ($1,$2,$3,$4) RETURNING id`, [house.id, c.id, firstName, lastName])).rows[0];
        const m = (await q.query(`INSERT INTO memberships (user_id, agency_id, role, traveler_id) VALUES ($1,$2,'traveller',$3) RETURNING *`, [u.id, house.id, t.id])).rows[0];
        return { user: u, membership: m };
      });
    } catch (e) { if (isUnique(e)) throw Object.assign(new Error("email taken"), { code: "EMAIL_TAKEN" }); throw e; }
  },

  async createStaffAccount({ agencyId, email, fullName, role }) {
    return db.withTransaction(async (q) => {
      let user = (await q.query(`SELECT ${USER_COLS} FROM users WHERE lower(email)=lower($1)`, [email])).rows[0]; let isNewUser = false;
      if (!user) { user = (await q.query(`INSERT INTO users (email, full_name) VALUES ($1,$2) RETURNING ${USER_COLS}`, [email, fullName])).rows[0]; isNewUser = true; }
      const m = (await q.query(`INSERT INTO memberships (user_id, agency_id, role) VALUES ($1,$2,$3) ON CONFLICT (user_id, agency_id) DO NOTHING RETURNING *`, [user.id, agencyId, role])).rows[0];
      if (!m) throw Object.assign(new Error("already a member"), { code: "ALREADY_MEMBER" });
      return { user, membership: m, isNewUser };
    });
  },

  async listMemberships(userId) {
    const { rows } = await db.query(
      `SELECT m.id, m.role, m.agency_id, m.traveler_id, a.name AS agency_name, a.kind AS agency_kind, a.traveller_self_booking
         FROM memberships m JOIN agencies a ON a.id = m.agency_id
        WHERE m.user_id=$1 AND m.status='active' AND a.status='active'`, [userId]);
    return rows;
  },
  async listStaff(agencyId) {
    const { rows } = await db.query(
      `SELECT m.id AS membership_id, m.role, m.status, u.id AS user_id, u.email, u.full_name, u.email_verified_at, (u.password_hash IS NOT NULL) AS has_password, m.created_at
         FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.agency_id=$1 AND m.role IN ('admin','agent') ORDER BY m.created_at`, [agencyId]);
    return rows;
  },
  async setMembershipStatus(membershipId, agencyId, status) {
    const { rows } = await db.query(`UPDATE memberships SET status=$3 WHERE id=$1 AND agency_id=$2 AND role IN ('admin','agent') RETURNING id, user_id`, [membershipId, agencyId, status]);
    return rows[0] || null;
  },
  async countActiveAdmins(agencyId) { const { rows } = await db.query(`SELECT COUNT(*)::int n FROM memberships WHERE agency_id=$1 AND role='admin' AND status='active'`, [agencyId]); return rows[0].n; },

  async invalidateTokens(userId, purpose) { await db.query(`UPDATE user_tokens SET used_at=now() WHERE user_id=$1 AND purpose=$2 AND used_at IS NULL`, [userId, purpose]); },
  async saveToken({ userId, purpose, hash, expiresAt }) { await db.query(`INSERT INTO user_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1,$2,$3,$4)`, [userId, purpose, hash, expiresAt]); },
  async peekToken({ hash, purposes, now }) {
    const { rows } = await db.query(`SELECT user_id FROM user_tokens WHERE token_hash=$1 AND purpose = ANY($2) AND used_at IS NULL AND expires_at > $3`, [hash, purposes, now]);
    return rows[0] ? rows[0].user_id : null;
  },
  // Atomic single use: two concurrent requests cannot both succeed.
  async consumeToken({ hash, purposes, now }) {
    const { rows } = await db.query(`UPDATE user_tokens SET used_at=$3 WHERE token_hash=$1 AND purpose = ANY($2) AND used_at IS NULL AND expires_at > $3 RETURNING user_id`, [hash, purposes, now]);
    return rows[0] ? rows[0].user_id : null;
  },

  async markEmailVerified(userId) { await db.query(`UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()), updated_at=now() WHERE id=$1`, [userId]); },
  async setPassword(userId, hash) { await db.query(`UPDATE users SET password_hash=$2, failed_logins=0, locked_until=NULL, updated_at=now() WHERE id=$1`, [userId, hash]); },
  async revokeAllSessions(userId) { await db.query(`UPDATE user_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [userId]); },
  async recordFailedLogin(userId, { max, lockMinutes, now }) {
    await db.query(`UPDATE users SET failed_logins = failed_logins + 1, locked_until = CASE WHEN failed_logins + 1 >= $2 THEN $3::timestamptz ELSE locked_until END WHERE id=$1`, [userId, max, new Date(now.getTime() + lockMinutes * 60000)]);
  },
  async resetFailedLogins(userId) { await db.query(`UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=$1 AND (failed_logins<>0 OR locked_until IS NOT NULL)`, [userId]); },

  async createSession({ userId, membershipId, tokenHash, expiresAt, ip, userAgent }) {
    await db.query(`INSERT INTO user_sessions (user_id, membership_id, token_hash, expires_at, ip, user_agent) VALUES ($1,$2,$3,$4,$5,$6)`, [userId, membershipId, tokenHash, expiresAt, ip || null, (userAgent || "").slice(0, 300) || null]);
  },
  async findSession(tokenHash) {
    const { rows } = await db.query(
      `SELECT s.id, s.user_id, s.expires_at, s.revoked_at, s.last_used_at, u.status AS user_status, u.email_verified_at, u.full_name, u.email,
              m.role, m.agency_id, m.traveler_id, m.status AS membership_status, a.status AS agency_status, a.name AS agency_name, a.kind AS agency_kind, a.traveller_self_booking
         FROM user_sessions s JOIN users u ON u.id=s.user_id JOIN memberships m ON m.id=s.membership_id JOIN agencies a ON a.id=m.agency_id
        WHERE s.token_hash=$1`, [tokenHash]);
    return rows[0] || null;
  },
  async touchSession(id) { await db.query(`UPDATE user_sessions SET last_used_at=now() WHERE id=$1`, [id]); },
  async revokeSession(tokenHash) { await db.query(`UPDATE user_sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL`, [tokenHash]); },

  async agencyIsActive(agencyId) { const { rows } = await db.query(`SELECT 1 FROM agencies WHERE id=$1 AND status='active'`, [agencyId]); return rows.length > 0; },
};

module.exports = { Identity };
