const db = require("../db");

const TripApprovals = {
  async create(a) {
    const { rows } = await db.query(
      `INSERT INTO agent_trip_approvals (agency_id, trip_id, trip_item_id, offer_id, approved_price, currency, tolerance_pct, expires_at, approved_by_user_id, approved_by_role, consent_attested)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [a.agencyId, a.tripId, a.tripItemId, a.offerId, a.approvedPrice, a.currency, a.tolerancePct, a.expiresAt, a.approvedByUserId || null, a.approvedByRole || null, !!a.consentAttested]
    );
    return rows[0];
  },
  async get(id, agencyId) {
    const { rows } = await db.query(`SELECT * FROM agent_trip_approvals WHERE id=$1 AND agency_id=$2`, [id, agencyId]);
    return rows[0] || null;
  },
  // Atomic single-use: only one caller can flip active -> consumed, and only
  // while unexpired. Returns the row, or null if someone else got there first.
  async consume(id, agencyId) {
    const { rows } = await db.query(
      `UPDATE agent_trip_approvals SET status='consumed'
        WHERE id=$1 AND agency_id=$2 AND status='active' AND expires_at > now()
        RETURNING *`,
      [id, agencyId]
    );
    return rows[0] || null;
  },
  async attachBooking(id, agencyId, bookingId) {
    await db.query(`UPDATE agent_trip_approvals SET consumed_booking_id=$3 WHERE id=$1 AND agency_id=$2`, [id, agencyId, bookingId]);
  },
  // Flip lapsed approvals out of 'active' so the one-live-approval-per-item index doesn't block a fresh one.
  async expireStale(tripItemId, agencyId) {
    await db.query(`UPDATE agent_trip_approvals SET status='expired' WHERE trip_item_id=$1 AND agency_id=$2 AND status='active' AND expires_at <= now()`, [tripItemId, agencyId]);
  },
  async revoke(id, agencyId) {
    await db.query(`UPDATE agent_trip_approvals SET status='revoked' WHERE id=$1 AND agency_id=$2 AND status='active'`, [id, agencyId]);
  },
};

module.exports = { TripApprovals };
