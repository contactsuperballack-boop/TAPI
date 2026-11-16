const crypto = require("crypto");
const db = require("../db");
const { redactBookingAuditPayload, redactSupplierResponsePayload } = require("../domain/piiRedaction");
const { assertValidTransition, requiresSupplierReference, INTERMEDIATE_STATES } = require("../domain/bookingStateMachine");

/** Deterministic hash of a booking request body, used to detect the same
 * idempotency key being reused with a materially different body. Deep-sorts
 * object keys (recursively) so field ordering never affects the hash —
 * only sorting top-level keys would miss differences inside e.g. `contact`. */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function hashRequestBody(body) {
  return crypto.createHash("sha256").update(stableStringify(body)).digest("hex");
}

const Searches = {
  async create({ agencyId, type, criteria, supplierSearchRef }) {
    const { rows } = await db.query(
      `INSERT INTO searches (agency_id, type, criteria, supplier_search_ref, status)
       VALUES ($1,$2,$3,$4,'processing') RETURNING *`,
      [agencyId, type, criteria, supplierSearchRef]
    );
    return rows[0];
  },
  async get(id, agencyId) {
    const { rows } = await db.query(`SELECT * FROM searches WHERE id=$1 AND agency_id=$2`, [id, agencyId]);
    return rows[0] || null;
  },
  async markCompleted(id) {
    await db.query(`UPDATE searches SET status='completed' WHERE id=$1`, [id]);
  },
  async markFailed(id) {
    await db.query(`UPDATE searches SET status='failed' WHERE id=$1`, [id]);
  },
};

const Offers = {
  async bulkInsert(searchId, agencyId, type, supplierCode, normalizedOffers) {
    const inserted = [];
    for (const o of normalizedOffers) {
      const { rows } = await db.query(
        `INSERT INTO offers (search_id, agency_id, type, supplier_code, supplier_offer_ref, price, currency, payload, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (supplier_code, supplier_offer_ref) DO UPDATE SET payload = EXCLUDED.payload
         RETURNING *`,
        [searchId, agencyId, type, supplierCode, o.supplierOfferRef, o.price, o.currency, o, o.expiresAt]
      );
      inserted.push(rows[0]);
    }
    return inserted;
  },
  async get(id, agencyId) {
    const { rows } = await db.query(`SELECT * FROM offers WHERE id=$1 AND agency_id=$2`, [id, agencyId]);
    return rows[0] || null;
  },
  // P1-4: a completed search must return the offers already persisted for
  // it — previously the poll route had no way to re-fetch them, so a client
  // polling a search whose status had already flipped to 'completed' got an
  // empty response with no offers.
  async listBySearchId(searchId, agencyId) {
    const { rows } = await db.query(
      `SELECT * FROM offers WHERE search_id=$1 AND agency_id=$2 ORDER BY price ASC`,
      [searchId, agencyId]
    );
    return rows;
  },
};

const Bookings = {
  // P1-5: idempotency is only meaningful per tenant (matches the migration
  // 002 constraint change). Looking this up globally let one agency's key
  // collide with another's.
  async findByIdempotencyKey(agencyId, key) {
    const { rows } = await db.query(
      `SELECT * FROM bookings WHERE agency_id=$1 AND idempotency_key=$2`,
      [agencyId, key]
    );
    return rows[0] || null;
  },
  // Atomic insert (fixes a TOCTOU race): the old flow was "check if key
  // exists, then insert" — two concurrent requests with the same key could
  // both pass the check before either committed, and the loser would hit a
  // raw unique-constraint error instead of getting back the winner's
  // booking. ON CONFLICT DO NOTHING makes the insert itself the single
  // atomic decision point; whoever loses the race just re-fetches.
  //
  // Also detects (via request_hash) the same idempotency key being reused
  // with a materially different body — a client bug, not a legitimate
  // retry — so the caller can reject it instead of silently returning a
  // booking for a different offer/passenger set than what was just sent.
  //
  // Starts in 'created', not 'pending' — per the state machine, 'created'
  // means "row exists, nothing sent to the supplier yet." Callers must
  // explicitly transition to 'pending' right before calling the supplier
  // (see routes) so the transition audit trail has a real genesis record
  // instead of the booking silently starting mid-lifecycle.
  async createOrGetExisting({ agencyId, offerId, type, idempotencyKey, supplierCode, travelerIds, correlationId, requestHash }) {
    const { rows } = await db.query(
      `INSERT INTO bookings (agency_id, offer_id, type, idempotency_key, supplier_code, traveler_ids, correlation_id, status, request_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'created',$8)
       ON CONFLICT (agency_id, idempotency_key) DO NOTHING
       RETURNING *`,
      [agencyId, offerId, type, idempotencyKey, supplierCode, travelerIds, correlationId, requestHash]
    );
    if (rows[0]) {
      await db.query(
        `INSERT INTO booking_state_transitions (booking_id, from_status, to_status, actor, reason) VALUES ($1,NULL,'created','system','booking row created')`,
        [rows[0].id]
      );
      return { booking: rows[0], isNew: true, hashMismatch: false };
    }

    // Lost the race (or this is a genuine retry) — fetch what's there.
    const existing = await this.findByIdempotencyKey(agencyId, idempotencyKey);
    const hashMismatch = existing && existing.request_hash && existing.request_hash !== requestHash;
    return { booking: existing, isNew: false, hashMismatch: Boolean(hashMismatch) };
  },

  // Replaces the old, unvalidated setStatus(). Every status change now:
  //   1. Is checked against the state machine (domain/bookingStateMachine.js)
  //      — an illegal transition throws instead of silently happening.
  //   2. Enforces the guard rule that 'confirmed' requires a real supplier
  //      reference — a booking can no longer be marked confirmed on vibes.
  //   3. Is recorded in booking_state_transitions, atomically with the
  //      status update itself (same transaction) — this is what makes
  //      "manual operator intervention is recorded and auditable" true.
  async transition(id, toStatus, { supplierReference, checkoutUrl, actor = "system", reason, metadata } = {}) {
    return db.withTransaction(async (tx) => {
      const { rows: currentRows } = await tx.query(`SELECT * FROM bookings WHERE id=$1 FOR UPDATE`, [id]);
      const current = currentRows[0];
      if (!current) throw new Error(`Booking ${id} not found — cannot transition`);

      assertValidTransition(current.status, toStatus);

      const effectiveReference = supplierReference || current.supplier_reference;
      if (requiresSupplierReference(toStatus) && !effectiveReference) {
        throw new Error(
          `Cannot transition booking ${id} to 'confirmed' without a supplier confirmation reference. ` +
            `This guard exists specifically so a booking can never be marked confirmed on an assumption.`
        );
      }

      const { rows } = await tx.query(
        `UPDATE bookings SET status=$2, supplier_reference=COALESCE($3, supplier_reference),
                checkout_url=COALESCE($4, checkout_url), updated_at=now()
         WHERE id=$1 RETURNING *`,
        [id, toStatus, supplierReference || null, checkoutUrl || null]
      );

      await tx.query(
        `INSERT INTO booking_state_transitions (booking_id, from_status, to_status, actor, reason, metadata)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, current.status, toStatus, actor, reason || null, metadata || null]
      );

      return rows[0];
    });
  },

  /** Updates supplier_reference without a status transition — e.g. attaching a hotel async job ref while the booking stays 'pending'. Not a state-machine event, just a field update. */
  async attachSupplierReference(id, supplierReference) {
    const { rows } = await db.query(
      `UPDATE bookings SET supplier_reference=$2, updated_at=now() WHERE id=$1 RETURNING *`,
      [id, supplierReference]
    );
    return rows[0];
  },

  /** Full transition history for a booking — the actual audit trail, not just the current status. */
  async getTransitionHistory(bookingId) {
    const { rows } = await db.query(
      `SELECT * FROM booking_state_transitions WHERE booking_id=$1 ORDER BY created_at ASC`,
      [bookingId]
    );
    return rows;
  },

  // Supports automatic detection of stuck bookings (review: "a booking
  // stuck in an intermediate state is automatically detected"). See
  // scripts/reconcile.js for what actually acts on this.
  async findStuckInIntermediateState(thresholdMinutes = 15) {
    const { rows } = await db.query(
      `SELECT * FROM bookings
       WHERE status = ANY($1::text[]) AND updated_at < now() - ($2 || ' minutes')::interval
       ORDER BY updated_at ASC`,
      [INTERMEDIATE_STATES, thresholdMinutes]
    );
    return rows;
  },

  async get(id, agencyId) {
    const { rows } = await db.query(`SELECT * FROM bookings WHERE id=$1 AND agency_id=$2`, [id, agencyId]);
    return rows[0] || null;
  },
  // Fix for a confirmed gap: raw_request previously stored traveler/guest
  // PII (names, DOB, passport numbers, contact details) in plaintext with
  // no redaction. Fixed HERE, centrally — not at each call site — so a
  // future caller of recordSupplierAudit can't forget to redact. See
  // domain/piiRedaction.js for what this does and does NOT solve
  // (encryption-at-rest, retention policy, and access control are still
  // separate, unresolved infrastructure decisions).
  //
  // Sprint 1 hardening: raw_response was NOT redacted — only raw_request
  // was. The supplier's own response can echo the same traveler PII back
  // (confirmation payloads, error messages that quote the request, etc.),
  // so storing it verbatim reopened the exact gap the raw_request fix
  // closed. Now redacted with redactSupplierResponsePayload, a key-name
  // based (not shape-based) redactor — appropriate because several LetsFG
  // response shapes are still explicitly unverified (see
  // GO_LIVE_CHECKLIST.md); a precise redactor can't be written for a shape
  // nobody has confirmed yet.
  async recordSupplierAudit(bookingId, supplierCode, rawRequest, rawResponse, supplierStatus) {
    await db.query(
      `INSERT INTO supplier_bookings (booking_id, supplier_code, raw_request, raw_response, supplier_status)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        bookingId,
        supplierCode,
        redactBookingAuditPayload(rawRequest),
        redactSupplierResponsePayload(rawResponse),
        supplierStatus,
      ]
    );
  },
};

const HotelBookingDetails = {
  // Fix for a confirmed bug: `guests` is a JS array, and node-postgres's
  // default parameter serialization formats arrays as native Postgres array
  // literals (`{...}`), NOT JSON — it checks Array.isArray() before the
  // generic-object JSON.stringify path. Sending that for a `jsonb` column
  // is invalid input and Postgres rejects it with a raw DB error, which
  // isn't an ApiError, so it fell through to a bare 500. Every value bound
  // to a jsonb column that could be an array (not just a plain object) must
  // be explicitly JSON.stringify'd — plain objects happen to work by
  // accident of pg's serialization order, arrays do not.
  async upsert(bookingId, { supplierJobRef, confirmationNumber, guests, payLink, balanceDueBy, cancellationTerms, reservationFeeAmount, reservationFeeStatus }) {
    const { rows } = await db.query(
      `INSERT INTO hotel_booking_details
         (booking_id, supplier_job_ref, confirmation_number, guests, pay_link, balance_due_by, cancellation_terms, reservation_fee_amount, reservation_fee_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (booking_id) DO UPDATE SET
         supplier_job_ref = COALESCE(EXCLUDED.supplier_job_ref, hotel_booking_details.supplier_job_ref),
         confirmation_number = COALESCE(EXCLUDED.confirmation_number, hotel_booking_details.confirmation_number),
         guests = COALESCE(EXCLUDED.guests, hotel_booking_details.guests),
         pay_link = COALESCE(EXCLUDED.pay_link, hotel_booking_details.pay_link),
         balance_due_by = COALESCE(EXCLUDED.balance_due_by, hotel_booking_details.balance_due_by),
         cancellation_terms = COALESCE(EXCLUDED.cancellation_terms, hotel_booking_details.cancellation_terms),
         reservation_fee_amount = COALESCE(EXCLUDED.reservation_fee_amount, hotel_booking_details.reservation_fee_amount),
         reservation_fee_status = COALESCE(EXCLUDED.reservation_fee_status, hotel_booking_details.reservation_fee_status),
         updated_at = now()
       RETURNING *`,
      [bookingId, supplierJobRef || null, confirmationNumber || null, guests ? JSON.stringify(guests) : null, payLink || null, balanceDueBy || null, cancellationTerms || null, reservationFeeAmount || null, reservationFeeStatus || null]
    );
    return rows[0];
  },
  async get(bookingId) {
    const { rows } = await db.query(`SELECT * FROM hotel_booking_details WHERE booking_id=$1`, [bookingId]);
    return rows[0] || null;
  },
};

const BusBookingDetails = {
  async upsert(bookingId, { origin, destination, travelDate, pickupPoint, dropoffPoint, passengers, seatNumbers, operatorBookingRef }) {
    const { rows } = await db.query(
      `INSERT INTO bus_booking_details
       (booking_id, origin, destination, travel_date, pickup_point, dropoff_point, passengers, passenger_count, seat_numbers, operator_booking_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (booking_id) DO UPDATE SET
         origin=EXCLUDED.origin, destination=EXCLUDED.destination, travel_date=EXCLUDED.travel_date,
         pickup_point=EXCLUDED.pickup_point, dropoff_point=EXCLUDED.dropoff_point,
         passengers=EXCLUDED.passengers, passenger_count=EXCLUDED.passenger_count,
         seat_numbers=EXCLUDED.seat_numbers, operator_booking_ref=EXCLUDED.operator_booking_ref, updated_at=now()
       RETURNING *`,
      [bookingId, origin, destination, travelDate || null, pickupPoint || null, dropoffPoint || null,
       JSON.stringify(passengers || []), (passengers || []).length, JSON.stringify(seatNumbers || []), operatorBookingRef || null]
    );
    return rows[0];
  },
  async get(bookingId) {
    const { rows } = await db.query(`SELECT * FROM bus_booking_details WHERE booking_id=$1`, [bookingId]);
    return rows[0] || null;
  },
};

const Orders = {
  async findByIdempotencyKey(agencyId, idempotencyKey) {
    const { rows } = await db.query(`SELECT * FROM orders WHERE agency_id=$1 AND idempotency_key=$2`, [agencyId, idempotencyKey]);
    return rows[0] || null;
  },
  // Atomic, idempotent, AND now fully transactional (fixes a confirmed gap:
  // previously the order insert and the booking-attachment update were two
  // separate statements, so a partial-attachment failure left an orphaned
  // order with no rollback). Wrapping both in db.withTransaction means a
  // count mismatch rolls back the order insert too, not just the update.
  async createOrGetExisting({ agencyId, customerId, bookingIds, idempotencyKey, pricing }) {
    return db.withTransaction(async (tx) => {
      const { rows } = await tx.query(
        `INSERT INTO orders (agency_id, customer_id, status, total_price, currency, supplier_cost, markup_amount, service_fee, tax_amount, idempotency_key)
         VALUES ($1,$2,'open',$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (agency_id, idempotency_key) DO NOTHING
         RETURNING *`,
        [agencyId, customerId || null, pricing.totalPrice, pricing.currency, pricing.supplierCost, pricing.markupAmount, pricing.serviceFee, pricing.taxAmount, idempotencyKey]
      );
      if (!rows[0]) {
        // Conflict on insert — safety net for a race between two concurrent
        // first-time requests with the same key (the route layer should
        // already check findByIdempotencyKey before reaching here).
        const { rows: existingRows } = await tx.query(`SELECT * FROM orders WHERE agency_id=$1 AND idempotency_key=$2`, [agencyId, idempotencyKey]);
        return { order: existingRows[0], isNew: false };
      }

      const { rowCount } = await tx.query(
        `UPDATE bookings SET order_id=$1 WHERE id = ANY($2::uuid[]) AND agency_id=$3 AND order_id IS NULL`,
        [rows[0].id, bookingIds, agencyId]
      );
      if (rowCount !== bookingIds.length) {
        // Throwing here rolls back BOTH the order insert and the partial
        // attachment — no orphaned order, unlike the previous non-transactional version.
        throw new Error(
          `Could not attach all bookings to a new order — only ${rowCount}/${bookingIds.length} were claimable ` +
            `(at least one was claimed by a concurrent request). Rolled back; no order was created.`
        );
      }
      return { order: rows[0], isNew: true };
    });
  },
  async get(id, agencyId) {
    const { rows } = await db.query(`SELECT * FROM orders WHERE id=$1 AND agency_id=$2`, [id, agencyId]);
    return rows[0] || null;
  },
  async listBookings(orderId, agencyId) {
    const { rows } = await db.query(`SELECT * FROM bookings WHERE order_id=$1 AND agency_id=$2`, [orderId, agencyId]);
    return rows;
  },
  async setStatus(id, status) {
    const { rows } = await db.query(`UPDATE orders SET status=$2 WHERE id=$1 RETURNING *`, [id, status]);
    return rows[0];
  },
};

const Payments = {
  async createOrGetExisting({ agencyId, orderId, provider, amount, currency, idempotencyKey }) {
    const { rows } = await db.query(
      `INSERT INTO payments (agency_id, order_id, provider, status, amount, currency, idempotency_key)
       VALUES ($1,$2,$3,'pending',$4,$5,$6)
       ON CONFLICT (agency_id, idempotency_key) DO NOTHING
       RETURNING *`,
      [agencyId, orderId, provider, amount, currency, idempotencyKey]
    );
    if (rows[0]) return { payment: rows[0], isNew: true };
    const { rows: existingRows } = await db.query(`SELECT * FROM payments WHERE agency_id=$1 AND idempotency_key=$2`, [agencyId, idempotencyKey]);
    return { payment: existingRows[0], isNew: false };
  },
  async setProviderRef(id, providerRef, checkoutUrl) {
    const { rows } = await db.query(
      `UPDATE payments SET provider_ref=$2, checkout_url=COALESCE($3, checkout_url) WHERE id=$1 RETURNING *`,
      [id, providerRef, checkoutUrl || null]
    );
    return rows[0];
  },
  async findByProviderRef(provider, providerRef) {
    const { rows } = await db.query(`SELECT * FROM payments WHERE provider=$1 AND provider_ref=$2`, [provider, providerRef]);
    return rows[0] || null;
  },
  // T-072/T-073: webhook is the ONLY path that can move a payment to
  // 'captured' or mark it 'failed' — never a client callback. Also records
  // webhook_verified_at so it's auditable that this specifically came
  // through signature verification, not some other code path.
  async markCapturedFromWebhook(id) {
    const { rows } = await db.query(
      `UPDATE payments SET status='captured', webhook_verified_at=now() WHERE id=$1 RETURNING *`,
      [id]
    );
    return rows[0];
  },
  // Transactional: marking the payment captured and the order paid must not
  // be two independent writes that could partially land if the process
  // crashes between them (Master Spec §12: "Internal order state changes
  // must be transactional where possible").
  // Hardened per the review's payment-integrity section:
  //   - Row-locked (FOR UPDATE) against a genuine race between two
  //     concurrent webhook deliveries for the same payment — the earlier
  //     version's status check happened outside any lock, same TOCTOU
  //     pattern the booking idempotency fix closed earlier.
  //   - Guard rule: "a payment cannot be captured for a failed or
  //     cancelled booking." Checks every booking under the order before
  //     capturing — a booking can drift to cancelled/refund_* between
  //     order creation and webhook delivery, and capturing money for that
  //     booking anyway would be a real integrity violation, not an edge case.
  //   - Records the provider's own event id when available (real
  //     providers give a stable id per event, stable across retried
  //     deliveries) — belt-and-suspenders dedup alongside the status check.
  async markCapturedAndOrderPaid(paymentId, orderId, eventId) {
    return db.withTransaction(async (tx) => {
      const { rows: paymentRows } = await tx.query(`SELECT * FROM payments WHERE id=$1 FOR UPDATE`, [paymentId]);
      const payment = paymentRows[0];
      if (!payment) throw new Error(`Payment ${paymentId} not found`);
      if (payment.status === "captured" || payment.status === "failed") {
        return { payment, order: null, alreadyProcessed: true };
      }

      const { rows: bookingRows } = await tx.query(`SELECT id, status FROM bookings WHERE order_id=$1`, [orderId]);
      const NOT_CAPTURABLE = new Set(["failed", "cancelled", "cancel_requested", "refund_pending", "refunded", "refund_failed"]);
      const blocking = bookingRows.find((b) => NOT_CAPTURABLE.has(b.status));
      if (blocking) {
        const err = new Error(`Cannot capture payment ${paymentId} for order ${orderId} — booking ${blocking.id} is '${blocking.status}', not in a capturable state.`);
        err.code = "BOOKING_NOT_CAPTURABLE";
        throw err;
      }

      const { rows: updatedPaymentRows } = await tx.query(
        `UPDATE payments SET status='captured', webhook_verified_at=now(), provider_event_id=COALESCE($2, provider_event_id) WHERE id=$1 RETURNING *`,
        [paymentId, eventId || null]
      );
      const { rows: orderRows } = await tx.query(`UPDATE orders SET status='paid' WHERE id=$1 RETURNING *`, [orderId]);
      return { payment: updatedPaymentRows[0], order: orderRows[0], alreadyProcessed: false };
    });
  },
  async markFailedFromWebhook(id) {
    const { rows } = await db.query(
      `UPDATE payments SET status='failed', webhook_verified_at=now() WHERE id=$1 RETURNING *`,
      [id]
    );
    return rows[0];
  },
  async markRefunded(id) {
    const { rows } = await db.query(`UPDATE payments SET status='refunded' WHERE id=$1 RETURNING *`, [id]);
    return rows[0];
  },
  async get(id, agencyId) {
    const { rows } = await db.query(`SELECT * FROM payments WHERE id=$1 AND agency_id=$2`, [id, agencyId]);
    return rows[0] || null;
  },
  async getByOrderId(orderId, agencyId) {
    const { rows } = await db.query(`SELECT * FROM payments WHERE order_id=$1 AND agency_id=$2 ORDER BY created_at DESC LIMIT 1`, [orderId, agencyId]);
    return rows[0] || null;
  },
};

module.exports = { Searches, Offers, Bookings, HotelBookingDetails, BusBookingDetails, Orders, Payments, hashRequestBody };
