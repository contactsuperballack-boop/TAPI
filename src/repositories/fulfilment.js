const db = require("../db");
const { openPassport } = require("../services/travelerSecrets");

const COLS = `f.id, f.agency_id, f.trip_id, f.trip_item_id, f.approval_id, f.status, f.requested_by_role, f.traveller_note, f.approved_price, f.currency,
  f.claimed_by_user_id, f.claimed_at, f.confirmation_ref, f.final_price, f.agent_note, f.decline_reason, f.completed_at, f.created_at, f.updated_at,
  t.title AS trip_title, t.traveler_id, i.kind AS item_kind, i.details AS item_details, i.offer_id,
  tr.first_name AS traveller_first_name, tr.last_name AS traveller_last_name, c.email AS traveller_email,
  u.full_name AS claimed_by_name, a.expires_at AS approval_expires_at, a.status AS approval_status`;
const FROM = `FROM fulfilment_requests f
  JOIN agent_trips t ON t.id = f.trip_id JOIN agent_trip_items i ON i.id = f.trip_item_id JOIN agent_trip_approvals a ON a.id = f.approval_id
  LEFT JOIN travelers tr ON tr.id = t.traveler_id LEFT JOIN customers c ON c.id = tr.customer_id LEFT JOIN users u ON u.id = f.claimed_by_user_id`;

class Rollback extends Error { constructor(reason) { super(reason); this.reason = reason; } }
const tx = async (fn) => { try { return await db.withTransaction(fn); } catch (e) { if (e instanceof Rollback) return { ok: false, reason: e.reason }; throw e; } };

const Fulfilment = {
  async get(id, agencyId) {
    const { rows } = await db.query(
      `SELECT ${COLS} ${FROM} WHERE f.id=$1 AND f.agency_id=$2`,
      [id, agencyId]
    );
    return rows[0] || null;
  },

  async list(agencyId, { scope = "open", userId } = {}) {
    const where = scope === "mine"
      ? `f.status='claimed' AND ($2::uuid IS NULL OR f.claimed_by_user_id=$2::uuid)`
      : scope === "done"
        ? `f.status IN ('completed','declined','cancelled')`
        : `f.status='open'`;
    const order = scope === "done" ? "f.updated_at DESC" : "f.created_at ASC";
    const params = scope === "mine" ? [agencyId, userId || null] : [agencyId];
    const { rows } = await db.query(
      `SELECT ${COLS} ${FROM} WHERE f.agency_id=$1 AND ${where} ORDER BY ${order} LIMIT 100`,
      params
    );
    return rows;
  },
  // New request + item flips to agent_requested, atomically. The partial unique index allows only one live request per item.
  async createWithItem({ agencyId, tripId, itemId, approvalId, requestedByUserId, requestedByRole, travellerNote, approvedPrice, currency }) {
    return db.withTransaction(async (q) => {
      const r = (await q.query(
        `INSERT INTO fulfilment_requests (agency_id, trip_id, trip_item_id, approval_id, requested_by_user_id, requested_by_role, traveller_note, approved_price, currency)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [agencyId, tripId, itemId, approvalId, requestedByUserId || null, requestedByRole || null, travellerNote || null, approvedPrice, currency])).rows[0];
      await q.query(`UPDATE agent_trip_items SET status='agent_requested', fulfilment_mode='agent_assisted', updated_at=now() WHERE id=$1 AND agency_id=$2`, [itemId, agencyId]);
      return r;
    });
  },

  // Atomic: of two agents clicking at once, exactly one gets a row back.
  async claim(id, agencyId, userId) {
    return db.withTransaction(async (q) => {
      const r = (await q.query(`UPDATE fulfilment_requests SET status='claimed', claimed_by_user_id=$3, claimed_at=now(), updated_at=now()
                                 WHERE id=$1 AND agency_id=$2 AND status='open' RETURNING id, trip_item_id`, [id, agencyId, userId || null])).rows[0];
      if (!r) return null;
      await q.query(`UPDATE agent_trip_items SET status='agent_working', updated_at=now() WHERE id=$1 AND agency_id=$2`, [r.trip_item_id, agencyId]);
      return r;
    });
  },

  async release(id, agencyId, claimedBy) {
    return db.withTransaction(async (q) => {
      const r = (await q.query(`UPDATE fulfilment_requests SET status='open', claimed_by_user_id=NULL, claimed_at=NULL, updated_at=now() WHERE id=$1 AND agency_id=$2 AND status='claimed' AND claimed_by_user_id IS NOT DISTINCT FROM $3::uuid RETURNING trip_item_id`, [id, agencyId, claimedBy || null])).rows[0];
      if (!r) return null;
      await q.query(`UPDATE agent_trip_items SET status='agent_requested', updated_at=now() WHERE id=$1 AND agency_id=$2`, [r.trip_item_id, agencyId]);
      return r;
    });
  },

  // Spend the single-use approval, record the confirmation and confirm the item, all or nothing.
  async complete(req, { confirmationRef, finalPrice, note }) {
    return tx(async (q) => {
      const ap = (await q.query(`UPDATE agent_trip_approvals SET status='consumed', consumed_at=now(), consumed_booking_id=$3 WHERE id=$1 AND agency_id=$2 AND status='active' AND expires_at > now() RETURNING id`, [req.approval_id, req.agency_id, confirmationRef])).rows[0];
      if (!ap) throw new Rollback("APPROVAL_UNAVAILABLE");
      const r = (await q.query(`UPDATE fulfilment_requests SET status='completed', confirmation_ref=$3, final_price=$4, agent_note=$5, completed_at=now(), updated_at=now() WHERE id=$1 AND agency_id=$2 AND status='claimed' AND claimed_by_user_id IS NOT DISTINCT FROM $6::uuid RETURNING id`,
        [req.id, req.agency_id, confirmationRef, finalPrice, note || null, req.claimed_by_user_id || null])).rows[0];
      if (!r) throw new Rollback("NOT_CLAIMED");
      await q.query(`UPDATE agent_trip_items SET status='confirmed', confirmation_ref=$3, quoted_price=$4, price_label='confirmed', updated_at=now() WHERE id=$1 AND agency_id=$2`, [req.trip_item_id, req.agency_id, confirmationRef, finalPrice]);
      return { ok: true };
    });
  },

  async decline(req, reason) {
    return tx(async (q) => {
      const r = (await q.query(`UPDATE fulfilment_requests SET status='declined', decline_reason=$3, updated_at=now() WHERE id=$1 AND agency_id=$2 AND status='claimed' AND claimed_by_user_id IS NOT DISTINCT FROM $4::uuid RETURNING id`, [req.id, req.agency_id, reason, req.claimed_by_user_id || null])).rows[0];
      if (!r) throw new Rollback("NOT_CLAIMED");
      await q.query(`UPDATE agent_trip_approvals SET status='revoked' WHERE id=$1 AND agency_id=$2 AND status='active'`, [req.approval_id, req.agency_id]);
      await q.query(`UPDATE agent_trip_items SET status='failed', updated_at=now() WHERE id=$1 AND agency_id=$2`, [req.trip_item_id, req.agency_id]);
      return { ok: true };
    });
  },

  // Price changed: the traveller must approve the new number. Old approval revoked; item goes back to 'selected'.
  async reprice(req, { newPrice, note }) {
    return tx(async (q) => {
      const r = (await q.query(`UPDATE fulfilment_requests SET status='cancelled', agent_note=$3, updated_at=now() WHERE id=$1 AND agency_id=$2 AND status='claimed' AND claimed_by_user_id IS NOT DISTINCT FROM $4::uuid RETURNING id`, [req.id, req.agency_id, note, req.claimed_by_user_id || null])).rows[0];
      if (!r) throw new Rollback("NOT_CLAIMED");
      await q.query(`UPDATE agent_trip_approvals SET status='revoked' WHERE id=$1 AND agency_id=$2 AND status='active'`, [req.approval_id, req.agency_id]);
      await q.query(`UPDATE agent_trip_items SET status='selected', fulfilment_mode='automated', quoted_price=$3, price_label='estimated', updated_at=now() WHERE id=$1 AND agency_id=$2`, [req.trip_item_id, req.agency_id, newPrice]);
      return { ok: true };
    });
  },

  // The requester withdraws before any agent has started.
  async cancelOpen(itemId, agencyId) {
    return db.withTransaction(async (q) => {
      const r = (await q.query(`UPDATE fulfilment_requests SET status='cancelled', agent_note='Withdrawn by the requester', updated_at=now() WHERE trip_item_id=$1 AND agency_id=$2 AND status='open' RETURNING approval_id`, [itemId, agencyId])).rows[0];
      if (!r) return null;
      await q.query(`UPDATE agent_trip_approvals SET status='revoked' WHERE id=$1 AND agency_id=$2 AND status='active'`, [r.approval_id, agencyId]);
      await q.query(`UPDATE agent_trip_items SET status='selected', fulfilment_mode='automated', updated_at=now() WHERE id=$1 AND agency_id=$2`, [itemId, agencyId]);
      return r;
    });
  },

  // Full details for the agent who is doing the booking. Callers must audit every use.
  async travellerDetails(travelerId, agencyId) {
    const { rows } = await db.query(
      `SELECT t.id, t.first_name, t.last_name, to_char(t.date_of_birth,'YYYY-MM-DD') AS date_of_birth, t.passport_number, t.passport_number_enc, t.nationality, c.email, c.phone
         FROM travelers t LEFT JOIN customers c ON c.id=t.customer_id WHERE t.id=$1 AND t.agency_id=$2`, [travelerId, agencyId]);
    const r = rows[0];
    if (!r) return null;
    const { passport_number_enc, id, ...rest } = r;
    return { ...rest, passport_number: openPassport(r) };
  },
};

module.exports = { Fulfilment };
