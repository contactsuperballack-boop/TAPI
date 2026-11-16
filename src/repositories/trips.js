const db = require("../db");

// DATE columns come back from pg as JS Dates (timezone-shifting, and rejected by TAPI's YYYY-MM-DD booking schema),
// so every query here returns them as plain 'YYYY-MM-DD' text.
const TRIP_COLS = `id, agency_id, traveler_id, title, origin, destination, start_date::text AS start_date, end_date::text AS end_date,
  budget, currency, status, brief, created_at, updated_at`;
const TRIP_COLS_T = `t.id, t.agency_id, t.traveler_id, t.title, t.origin, t.destination, t.start_date::text AS start_date, t.end_date::text AS end_date,
  t.budget, t.currency, t.status, t.brief, t.created_at, t.updated_at`;

const Trips = {
  async create({ agencyId, travelerId, createdByUserId, title, origin, destination, startDate, endDate, budget, currency, brief }) {
    const { rows } = await db.query(
      `INSERT INTO agent_trips (agency_id, traveler_id, created_by_user_id, title, origin, destination, start_date, end_date, budget, currency, brief)
       VALUES ($1,$2,$11,$3,$4,$5,$6,$7,$8,$9,COALESCE($10,'{}'::jsonb)) RETURNING ${TRIP_COLS}`,
      [agencyId, travelerId || null, title, origin || null, destination || null, startDate || null, endDate || null, budget ?? null, currency || null, brief ? JSON.stringify(brief) : null, createdByUserId || null]
    );
    return rows[0];
  },
  async get(id, agencyId) {
    const { rows } = await db.query(`SELECT ${TRIP_COLS} FROM agent_trips WHERE id=$1 AND agency_id=$2`, [id, agencyId]);
    return rows[0] || null;
  },
  async listItems(tripId, agencyId) {
    const { rows } = await db.query(
      `SELECT i.*, a.id AS approval_id, a.expires_at AS approval_expires_at,
              fr.id AS request_id, fr.status AS request_status, fr.agent_note AS request_agent_note, fr.decline_reason AS request_decline_reason,
              fr.traveller_note AS request_traveller_note, fu.full_name AS request_agent_name
         FROM agent_trip_items i
         LEFT JOIN agent_trip_approvals a ON a.trip_item_id = i.id AND a.status = 'active' AND a.expires_at > now()
         LEFT JOIN LATERAL (SELECT * FROM fulfilment_requests f WHERE f.trip_item_id = i.id ORDER BY f.created_at DESC LIMIT 1) fr ON true
         LEFT JOIN users fu ON fu.id = fr.claimed_by_user_id
        WHERE i.trip_id=$1 AND i.agency_id=$2 ORDER BY i.created_at`, [tripId, agencyId]);
    return rows;
  },
  async getItem(itemId, tripId, agencyId) {
    const { rows } = await db.query(`SELECT * FROM agent_trip_items WHERE id=$1 AND trip_id=$2 AND agency_id=$3`, [itemId, tripId, agencyId]);
    return rows[0] || null;
  },
  async addProposedItem({ agencyId, tripId, kind, offerId, quotedPrice, currency, priceLabel, details }) {
    const { rows } = await db.query(
      `INSERT INTO agent_trip_items (agency_id, trip_id, kind, status, offer_id, quoted_price, currency, price_label, details)
       SELECT $1,$2,$3,'proposed',$4,$5,$6,$7,COALESCE($8::jsonb,'{}'::jsonb) WHERE EXISTS (SELECT 1 FROM agent_trips WHERE id=$2 AND agency_id=$1)
       RETURNING *`,
      [agencyId, tripId, kind, offerId, quotedPrice, currency, priceLabel, details ? JSON.stringify(details) : null]
    );
    if (!rows[0]) throw Object.assign(new Error("Trip not found"), { code: "NOT_FOUND" });
    return rows[0];
  },
  async setItemStatus(itemId, agencyId, status, bookingId) {
    await db.query(
      `UPDATE agent_trip_items SET status=$3, booking_id=COALESCE($4, booking_id), updated_at=now() WHERE id=$1 AND agency_id=$2`,
      [itemId, agencyId, status, bookingId || null]
    );
  },
  async event(agencyId, tripId, type, payload) {
    await db.query(`INSERT INTO agent_trip_events (agency_id, trip_id, type, payload) VALUES ($1,$2,$3,$4)`, [agencyId, tripId, type, JSON.stringify(payload || {})]);
  },
  // Booking details come from TAPI's own travelers/customers tables, resolved server-side. They never pass through the model.
  async bookingParties(trip) {
    if (!trip.traveler_id) return null;
    const { rows } = await db.query(
      `SELECT t.first_name, t.last_name, to_char(t.date_of_birth,'YYYY-MM-DD') AS date_of_birth, t.passport_number, t.nationality, c.email, c.phone
         FROM travelers t LEFT JOIN customers c ON c.id = t.customer_id
        WHERE t.id=$1 AND t.agency_id=$2`, [trip.traveler_id, trip.agency_id]);
    return rows[0] || null;
  },
};

Object.assign(Trips, {
  async setItemMode(itemId, agencyId, mode) { await db.query(`UPDATE agent_trip_items SET fulfilment_mode=$3, updated_at=now() WHERE id=$1 AND agency_id=$2`, [itemId, agencyId, mode]); },
  // The supplier just revalidated this price at booking time, so it is now a confirmed price.
  async confirmPrice(itemId, agencyId, price) {
    await db.query(`UPDATE agent_trip_items SET quoted_price=$3, price_label='confirmed', updated_at=now() WHERE id=$1 AND agency_id=$2`, [itemId, agencyId, price]);
  },
  // After a blocked booking: put the item back in front of the user with the fresh price (or none), approval revoked.
  async reopenItem(itemId, agencyId, { status, quotedPrice, priceLabel }) {
    await db.query(
      `UPDATE agent_trip_items SET status=$3, quoted_price=COALESCE($4, quoted_price), price_label=COALESCE($5, price_label), updated_at=now()
        WHERE id=$1 AND agency_id=$2`, [itemId, agencyId, status, quotedPrice ?? null, priceLabel || null]);
    await db.query(`UPDATE agent_trip_approvals SET status='revoked' WHERE trip_item_id=$1 AND agency_id=$2 AND status='active'`, [itemId, agencyId]);
  },
  async list(agencyId, { travelerId } = {}) {
    const { rows } = await db.query(
      `SELECT ${TRIP_COLS_T}, COALESCE(c.n,0)::int AS item_count, COALESCE(c.confirmed,0)::int AS confirmed_count
         FROM agent_trips t
         LEFT JOIN (SELECT trip_id, COUNT(*) n, COUNT(*) FILTER (WHERE status='confirmed') confirmed
                      FROM agent_trip_items WHERE agency_id=$1 GROUP BY trip_id) c ON c.trip_id = t.id
        WHERE t.agency_id=$1 AND ($2::uuid IS NULL OR t.traveler_id = $2::uuid) ORDER BY t.updated_at DESC LIMIT 100`, [agencyId, travelerId || null]);
    return rows;
  },
  async update(id, agencyId, { title, travelerId }) {
    const { rows } = await db.query(
      `UPDATE agent_trips SET title=COALESCE($3,title), traveler_id=COALESCE($4,traveler_id), updated_at=now()
        WHERE id=$1 AND agency_id=$2 RETURNING ${TRIP_COLS}`, [id, agencyId, title || null, travelerId || null]);
    return rows[0] || null;
  },
  async setStatus(id, agencyId, status) {
    await db.query(`UPDATE agent_trips SET status=$3, updated_at=now() WHERE id=$1 AND agency_id=$2`, [id, agencyId, status]);
  },
  async events(tripId, agencyId) {
    const { rows } = await db.query(`SELECT id, type, payload, created_at FROM agent_trip_events WHERE trip_id=$1 AND agency_id=$2 ORDER BY created_at DESC LIMIT 100`, [tripId, agencyId]);
    return rows;
  },
  async addMessage({ agencyId, tripId, role, content, toolTrace }) {
    await db.query(`INSERT INTO agent_trip_messages (agency_id, trip_id, role, content, tool_trace) VALUES ($1,$2,$3,$4,$5)`,
      [agencyId, tripId, role, content, toolTrace ? JSON.stringify(toolTrace) : null]);
  },
  async messages(tripId, agencyId) {
    const { rows } = await db.query(`SELECT id, role, content, tool_trace, created_at FROM agent_trip_messages WHERE trip_id=$1 AND agency_id=$2 ORDER BY created_at`, [tripId, agencyId]);
    return rows;
  },
  async travelerBelongsToAgency(travelerId, agencyId) {
    const { rows } = await db.query(`SELECT 1 FROM travelers WHERE id=$1 AND agency_id=$2`, [travelerId, agencyId]);
    return rows.length > 0;
  },
});

module.exports = { Trips };
