const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const { Errors, ApiError } = require("../domain/errors");
const { hashRequestBody } = require("../repositories");
const { assertValidTransition, InvalidMobilityTransitionError } = require("../domain/mobilityBookingStateMachine");

const router = express.Router();
const actor = (req) => req.tenant?.apiClientId || "api";
const token = () => `hold_${crypto.randomBytes(18).toString("hex")}`;
const reference = () => `BUS-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;

// Sprint 1 hardening: was writing to a separate audit_logs table (migration
// 010), diverging from the rest of the app's single audit_events table
// (migration 001, populated centrally by middleware/auditLog.js). Merged via
// migration 011 — this now writes to the same table everything else does, so
// an "all activity for this agency" query doesn't have to know mobility used
// to be special.
async function audit(client, req, action, resourceType, resourceId, metadata = {}) {
  await client.query(`INSERT INTO audit_events (agency_id, actor, action, resource_type, resource_id, metadata) VALUES ($1,$2,$3,$4,$5,$6)`, [req.tenant.agencyId, actor(req), action, resourceType, resourceId || null, metadata]);
}
async function expireHolds(client, agencyId, tripId) {
  const { rows } = await client.query(`SELECT id, seat_ids FROM seat_holds WHERE agency_id=$1 AND trip_id=$2 AND status='active' AND expires_at <= now() FOR UPDATE`, [agencyId, tripId]);
  for (const hold of rows) {
    await client.query(`UPDATE trip_seats SET status='available' WHERE id = ANY($1::uuid[]) AND status='held'`, [hold.seat_ids]);
    await client.query(`UPDATE seat_holds SET status='expired', released_at=now() WHERE id=$1`, [hold.id]);
  }
}

router.get("/dashboard/summary", async (req, res, next) => {
  try {
    const [trips, holds, bookings, settlements, integrations] = await Promise.all([
      db.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE status IN ('scheduled','boarding'))::int AS active FROM trips WHERE agency_id=$1`, [req.tenant.agencyId]),
      db.query(`SELECT count(*)::int AS active FROM seat_holds WHERE agency_id=$1 AND status='active' AND expires_at > now()`, [req.tenant.agencyId]),
      db.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE status='confirmed')::int AS confirmed, COALESCE(sum(total_amount) FILTER (WHERE status IN ('confirmed','boarded')),0)::float AS gross_amount FROM mobility_bookings WHERE agency_id=$1`, [req.tenant.agencyId]),
      db.query(`SELECT count(*)::int AS pending FROM settlements WHERE agency_id=$1 AND status IN ('pending','processing')`, [req.tenant.agencyId]),
      db.query(`SELECT count(*)::int AS degraded FROM integrations WHERE agency_id=$1 AND status IN ('degraded','down')`, [req.tenant.agencyId]),
    ]);
    res.json({ trips: trips.rows[0], holds: holds.rows[0], bookings: bookings.rows[0], settlements: settlements.rows[0], integrations: integrations.rows[0] });
  } catch (err) { next(err); }
});

router.post("/operators", async (req, res, next) => {
  try {
    const { name, code, contactEmail, contactPhone } = req.body;
    if (!name || !code) throw Errors.ValidationFailed("name and code are required");
    const { rows } = await db.query(`INSERT INTO operators (agency_id,name,code,contact_email,contact_phone) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [req.tenant.agencyId, name, code, contactEmail || null, contactPhone || null]);
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

router.post("/trips", async (req, res, next) => {
  try {
    const { operatorId, tripCode, origin, destination, departureAt, arrivalAt, currency, fare, seats } = req.body;
    if (!operatorId || !tripCode || !origin || !destination || !departureAt || fare === undefined || !Array.isArray(seats) || !seats.length) throw Errors.ValidationFailed("operatorId, tripCode, route, departureAt, fare, and seats are required");
    const result = await db.withTransaction(async (tx) => {
      const trip = await tx.query(`INSERT INTO trips (agency_id,operator_id,trip_code,origin,destination,departure_at,arrival_at,currency,fare) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9 WHERE EXISTS (SELECT 1 FROM operators WHERE id=$2 AND agency_id=$1) RETURNING *`, [req.tenant.agencyId, operatorId, tripCode, origin, destination, departureAt, arrivalAt || null, currency || "USD", fare]);
      if (!trip.rows[0]) throw Errors.NotFound("Operator");
      const created = await tx.query(`INSERT INTO trip_seats (trip_id,seat_number) SELECT $1, unnest($2::text[]) RETURNING *`, [trip.rows[0].id, seats]);
      return { ...trip.rows[0], seats: created.rows };
    });
    res.status(201).json(result);
  } catch (err) { next(err); }
});

router.get("/trips", async (req, res, next) => {
  try {
    const params = [req.tenant.agencyId]; const where = ["t.agency_id=$1"];
    if (req.query.origin) { params.push(req.query.origin); where.push(`t.origin=$${params.length}`); }
    if (req.query.destination) { params.push(req.query.destination); where.push(`t.destination=$${params.length}`); }
    if (req.query.date) { params.push(req.query.date); where.push(`t.departure_at::date=$${params.length}`); }
    const { rows } = await db.query(`SELECT t.*, o.name AS operator_name, count(ts.id) FILTER (WHERE ts.status='available')::int AS available_seats, count(ts.id)::int AS total_seats FROM trips t JOIN operators o ON o.id=t.operator_id LEFT JOIN trip_seats ts ON ts.trip_id=t.id WHERE ${where.join(" AND ")} GROUP BY t.id,o.name ORDER BY t.departure_at`, params);
    res.json({ trips: rows });
  } catch (err) { next(err); }
});

router.get("/trips/:tripId/seats", async (req, res, next) => {
  try {
    const { rows } = await db.query(`SELECT ts.*, sh.expires_at AS hold_expires_at FROM trip_seats ts LEFT JOIN LATERAL (SELECT expires_at FROM seat_holds WHERE trip_id=ts.trip_id AND ts.id = ANY(seat_ids) AND status='active' AND expires_at > now() ORDER BY expires_at DESC LIMIT 1) sh ON true JOIN trips t ON t.id=ts.trip_id WHERE ts.trip_id=$1 AND t.agency_id=$2 ORDER BY ts.seat_number`, [req.params.tripId, req.tenant.agencyId]);
    res.json({ tripId: req.params.tripId, seats: rows });
  } catch (err) { next(err); }
});

router.post("/trips/:tripId/holds", async (req, res, next) => {
  try {
    const { seatIds, ttlSeconds = 600 } = req.body;
    if (!Array.isArray(seatIds) || !seatIds.length || seatIds.length > 20) throw Errors.ValidationFailed("seatIds must contain 1 to 20 seats");
    const result = await db.withTransaction(async (tx) => {
      await expireHolds(tx, req.tenant.agencyId, req.params.tripId);
      const trip = await tx.query(`SELECT id FROM trips WHERE id=$1 AND agency_id=$2 FOR UPDATE`, [req.params.tripId, req.tenant.agencyId]);
      if (!trip.rows[0]) throw Errors.NotFound("Trip");
      const seats = await tx.query(`SELECT id,status FROM trip_seats WHERE trip_id=$1 AND id = ANY($2::uuid[]) FOR UPDATE`, [req.params.tripId, seatIds]);
      if (seats.rows.length !== seatIds.length || seats.rows.some((s) => s.status !== "available")) throw new ApiError("SEATS_UNAVAILABLE", 409, "Seats unavailable", "One or more requested seats are already held, booked, or blocked.");
      const hold = await tx.query(`INSERT INTO seat_holds (agency_id,trip_id,hold_token,seat_ids,expires_at) VALUES ($1,$2,$3,$4,now()+($5 || ' seconds')::interval) RETURNING *`, [req.tenant.agencyId, req.params.tripId, token(), seatIds, Math.max(30, Math.min(1800, Number(ttlSeconds)))]);
      await tx.query(`UPDATE trip_seats SET status='held' WHERE id = ANY($1::uuid[])`, [seatIds]);
      await audit(tx, req, "hold.created", "seat_hold", hold.rows[0].id, { seatIds });
      return hold.rows[0];
    });
    res.status(201).json(result);
  } catch (err) { next(err); }
});

router.post("/holds/:holdId/release", async (req, res, next) => {
  try {
    const result = await db.withTransaction(async (tx) => {
      const hold = await tx.query(`SELECT * FROM seat_holds WHERE id=$1 AND agency_id=$2 FOR UPDATE`, [req.params.holdId, req.tenant.agencyId]);
      if (!hold.rows[0]) throw Errors.NotFound("Seat hold");
      if (hold.rows[0].status !== "active") return hold.rows[0];
      await tx.query(`UPDATE trip_seats SET status='available' WHERE id = ANY($1::uuid[]) AND status='held'`, [hold.rows[0].seat_ids]);
      const updated = await tx.query(`UPDATE seat_holds SET status='released', released_at=now() WHERE id=$1 RETURNING *`, [req.params.holdId]);
      await audit(tx, req, "hold.released", "seat_hold", req.params.holdId);
      return updated.rows[0];
    });
    res.json(result);
  } catch (err) { next(err); }
});

router.post("/bookings", async (req, res, next) => {
  try {
    const { tripId, holdId, passenger, currency = "USD" } = req.body;
    const key = req.get("Idempotency-Key");
    if (!key) throw Errors.IdempotencyKeyRequired();
    if (!tripId || !holdId || !passenger) throw Errors.ValidationFailed("tripId, holdId, and passenger are required");
    // Sprint 1 hardening: same protection flights/hotels/orders already have
    // (Bookings.createOrGetExisting) — a repeated Idempotency-Key with a
    // DIFFERENT body must error, not silently return the original booking.
    // See migration 012 for the request_hash column this relies on.
    const requestHash = hashRequestBody({ tripId, holdId, passenger, currency });
    const result = await db.withTransaction(async (tx) => {
      const existing = await tx.query(`SELECT * FROM mobility_bookings WHERE agency_id=$1 AND idempotency_key=$2`, [req.tenant.agencyId, key]);
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash && existing.rows[0].request_hash !== requestHash) {
          throw Errors.IdempotencyKeyReused(key);
        }
        return { row: existing.rows[0], existing: true };
      }
      const hold = await tx.query(`SELECT h.*, t.fare, t.currency FROM seat_holds h JOIN trips t ON t.id=h.trip_id WHERE h.id=$1 AND h.trip_id=$2 AND h.agency_id=$3 FOR UPDATE`, [holdId, tripId, req.tenant.agencyId]);
      if (!hold.rows[0] || hold.rows[0].status !== "active" || new Date(hold.rows[0].expires_at) <= new Date()) throw new ApiError("HOLD_EXPIRED", 409, "Seat hold expired", "Create a new hold before booking.");
      const booking = await tx.query(`INSERT INTO mobility_bookings (agency_id,trip_id,hold_id,idempotency_key,request_hash,reference,passenger,seat_ids,total_amount,currency,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending') RETURNING *`, [req.tenant.agencyId, tripId, holdId, key, requestHash, reference(), passenger, hold.rows[0].seat_ids, hold.rows[0].fare * hold.rows[0].seat_ids.length, currency]);
      await tx.query(`UPDATE trip_seats SET status='booked' WHERE id = ANY($1::uuid[]) AND status='held'`, [hold.rows[0].seat_ids]);
      await tx.query(`UPDATE seat_holds SET status='converted' WHERE id=$1`, [holdId]);
      await audit(tx, req, "booking.created", "mobility_booking", booking.rows[0].id, { holdId, seatIds: hold.rows[0].seat_ids });
      return { row: booking.rows[0], existing: false };
    });
    res.status(result.existing ? 200 : 201).json(result.row);
  } catch (err) { next(err); }
});

router.get("/bookings", async (req, res, next) => {
  try {
    const params = [req.tenant.agencyId]; const where = ["b.agency_id=$1"];
    if (req.query.status) { params.push(req.query.status); where.push(`b.status=$${params.length}`); }
    if (req.query.tripId) { params.push(req.query.tripId); where.push(`b.trip_id=$${params.length}`); }
    const { rows } = await db.query(`SELECT b.*, t.trip_code, t.origin, t.destination, t.departure_at FROM mobility_bookings b JOIN trips t ON t.id=b.trip_id WHERE ${where.join(" AND ")} ORDER BY b.created_at DESC`, params);
    res.json({ bookings: rows });
  } catch (err) { next(err); }
});

router.get("/bookings/:bookingId", async (req, res, next) => {
  try {
    const { rows } = await db.query(`SELECT b.*, t.trip_code, t.origin, t.destination, t.departure_at FROM mobility_bookings b JOIN trips t ON t.id=b.trip_id WHERE b.id=$1 AND b.agency_id=$2`, [req.params.bookingId, req.tenant.agencyId]);
    if (!rows[0]) throw Errors.NotFound("Booking");
    res.json(rows[0]);
  } catch (err) { next(err); }
});

router.post("/bookings/:bookingId/transitions", async (req, res, next) => {
  try {
    const { toStatus, reason } = req.body;
    const result = await db.withTransaction(async (tx) => {
      const found = await tx.query(`SELECT * FROM mobility_bookings WHERE id=$1 AND agency_id=$2 FOR UPDATE`, [req.params.bookingId, req.tenant.agencyId]);
      if (!found.rows[0]) throw Errors.NotFound("Booking");
      // Sprint 1 hardening: was an inline object + membership check here.
      // Now goes through domain/mobilityBookingStateMachine.js — the same
      // single-source-of-truth pattern domain/bookingStateMachine.js
      // established for flights/hotels/orders, instead of a parallel,
      // less-rigorous convention. The domain layer stays HTTP-agnostic (it
      // throws InvalidMobilityTransitionError, not an ApiError, mirroring
      // bookingStateMachine.js) — the route is what maps that to a 409.
      try {
        assertValidTransition(found.rows[0].status, toStatus);
      } catch (e) {
        if (e instanceof InvalidMobilityTransitionError) {
          throw new ApiError("INVALID_BOOKING_TRANSITION", 409, "Invalid mobility booking transition", `${e.from} -> ${e.to} is not allowed.`);
        }
        throw e;
      }
      const updated = await tx.query(`UPDATE mobility_bookings SET status=$2, updated_at=now() WHERE id=$1 RETURNING *`, [req.params.bookingId, toStatus]);
      await audit(tx, req, "booking.transition", "mobility_booking", req.params.bookingId, { from: found.rows[0].status, to: toStatus, reason });
      return updated.rows[0];
    });
    res.json(result);
  } catch (err) { next(err); }
});

router.get("/integrations", async (req, res, next) => {
  try {
    const { rows } = await db.query(`SELECT * FROM integrations WHERE agency_id=$1 ORDER BY provider`, [req.tenant.agencyId]);
    res.json({ integrations: rows });
  } catch (err) { next(err); }
});

router.post("/integrations", async (req, res, next) => {
  try {
    const { operatorId, provider, externalAccountRef, status = "unknown", metadata = {} } = req.body;
    if (!provider) throw Errors.ValidationFailed("provider is required");
    const { rows } = await db.query(`INSERT INTO integrations (agency_id,operator_id,provider,external_account_ref,status,metadata,last_checked_at) VALUES ($1,$2,$3,$4,$5,$6,now()) RETURNING *`, [req.tenant.agencyId, operatorId || null, provider, externalAccountRef || null, status, metadata]);
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});
router.patch("/integrations/:integrationId/status", async (req, res, next) => {
  try {
    const { status, metadata = {} } = req.body;
    if (!["healthy","degraded","down","unknown"].includes(status)) throw Errors.ValidationFailed("invalid integration status");
    const { rows } = await db.query(`UPDATE integrations SET status=$1,metadata=$2,last_checked_at=now(),updated_at=now() WHERE id=$3 AND agency_id=$4 RETURNING *`, [status, metadata, req.params.integrationId, req.tenant.agencyId]);
    if (!rows[0]) throw Errors.NotFound("Integration");
    res.json(rows[0]);
  } catch (err) { next(err); }
});

router.get("/settlements", async (req, res, next) => {
  try { const { rows } = await db.query(`SELECT s.*, o.name AS operator_name FROM settlements s JOIN operators o ON o.id=s.operator_id WHERE s.agency_id=$1 ORDER BY s.created_at DESC`, [req.tenant.agencyId]); res.json({ settlements: rows }); } catch (err) { next(err); }
});
router.post("/settlements", async (req, res, next) => {
  try {
    const { operatorId, periodStart, periodEnd, amount, currency = "USD", status = "pending", externalReference } = req.body;
    if (!operatorId || !periodStart || !periodEnd || amount === undefined) throw Errors.ValidationFailed("operatorId, periodStart, periodEnd, and amount are required");
    const { rows } = await db.query(`INSERT INTO settlements (agency_id,operator_id,period_start,period_end,amount,currency,status,external_reference) SELECT $1,$2,$3,$4,$5,$6,$7,$8 WHERE EXISTS (SELECT 1 FROM operators WHERE id=$2 AND agency_id=$1) RETURNING *`, [req.tenant.agencyId, operatorId, periodStart, periodEnd, amount, currency, status, externalReference || null]);
    if (!rows[0]) throw Errors.NotFound("Operator");
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
