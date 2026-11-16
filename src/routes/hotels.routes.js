const express = require("express");
const { v4: uuid } = require("uuid");
const { getHotelSupplier } = require("../services/supplierRegistry");
const { Searches, Offers, Bookings, HotelBookingDetails, hashRequestBody } = require("../repositories");
const { requireIdempotencyKey } = require("../middleware/idempotency");
const { Errors } = require("../domain/errors");
const { mapBookingState, classifyBookingFailure } = require("../domain/bookingState");
const { hotelSearchSchema, hotelBookingSchema, validateBody } = require("../validation/schemas");

const router = express.Router();
const SUPPLIER_CODE = "letsfg"; // MVP: single supplier, Developer-API-only for hotels (see letsfgHotelAdapter.js)

// POST /v1/hotels/search — kick off an async search (T-051)
router.post("/search", validateBody(hotelSearchSchema), async (req, res, next) => {
  try {
    const { destination, checkIn, checkOut, guests, rooms, currency } = req.body;

    const supplier = getHotelSupplier(SUPPLIER_CODE);
    const { supplierSearchRef } = await supplier.search({ destination, checkIn, checkOut, adults: guests.adults, children: guests.children, rooms, currency });

    const search = await Searches.create({
      agencyId: req.tenant.agencyId,
      type: "hotel",
      criteria: req.body,
      supplierSearchRef,
    });

    res.status(202).json({ searchId: search.id, status: "processing", pollUrl: `/v1/hotels/search/${search.id}` });
  } catch (err) {
    next(err);
  }
});

// GET /v1/hotels/search/:searchId — poll results
router.get("/search/:searchId", async (req, res, next) => {
  try {
    const search = await Searches.get(req.params.searchId, req.tenant.agencyId);
    if (!search) throw Errors.NotFound("Search");

    if (search.status === "completed") {
      const stored = await Offers.listBySearchId(search.id, req.tenant.agencyId);
      return res.json({ searchId: search.id, status: "completed", offers: stored.map((o) => ({ offerId: o.id, ...o.payload })) });
    }
    if (search.status === "failed") {
      return res.json({ searchId: search.id, status: "failed" });
    }

    const supplier = getHotelSupplier(search.supplier_code || SUPPLIER_CODE);
    const result = await supplier.pollSearch(search.supplier_search_ref);

    if (result.status === "completed") {
      const stored = await Offers.bulkInsert(search.id, req.tenant.agencyId, "hotel", SUPPLIER_CODE, result.offers);
      await Searches.markCompleted(search.id);
      return res.json({ searchId: search.id, status: "completed", offers: stored.map((o) => ({ offerId: o.id, ...o.payload })) });
    }
    if (result.status === "failed") {
      await Searches.markFailed(search.id);
      return res.json({ searchId: search.id, status: "failed" });
    }
    res.json({ searchId: search.id, status: "processing" });
  } catch (err) {
    next(err);
  }
});

// GET /v1/hotels/:hotelId/offers/:offerId — rate detail (T-052)
// Modeled per Master Spec §9 as /hotels/{hotelId}/offers/{offerId}; hotelId
// isn't independently validated here in MVP since offer lookup is already
// tenant + id scoped — kept in the path to match the frozen contract.
router.get("/:hotelId/offers/:offerId", async (req, res, next) => {
  try {
    const offer = await Offers.get(req.params.offerId, req.tenant.agencyId);
    if (!offer) throw Errors.NotFound("Offer");
    if (new Date(offer.expires_at) < new Date()) throw Errors.OfferExpired(offer.id);
    res.json({ offerId: offer.id, ...offer.payload });
  } catch (err) {
    next(err);
  }
});

// POST /v1/hotels/offers/:offerId/validate — rate recheck before booking (T-053, T-063)
// CONFIRMED as required when rate_type=RECHECK; called unconditionally here
// since offer payloads don't yet reliably expose rate type (see adapter note).
router.post("/offers/:offerId/validate", async (req, res, next) => {
  try {
    const offer = await Offers.get(req.params.offerId, req.tenant.agencyId);
    if (!offer) throw Errors.NotFound("Offer");
    if (new Date(offer.expires_at) < new Date()) throw Errors.OfferExpired(offer.id);

    const supplier = getHotelSupplier(offer.supplier_code);
    const result = await supplier.validateOffer(offer.supplier_offer_ref);
    res.json({ offerId: offer.id, valid: result.valid, offer: result.offer });
  } catch (err) {
    next(err);
  }
});

// POST /v1/hotels/bookings — create booking (T-054, idempotent, ASYNC — T-055)
// Unlike flights, this never returns 'confirmed' synchronously. LetsFG's own
// warning: never retry a hotel booking call blindly, it double-books and
// double-charges the 5% reservation fee — idempotency (agency_id +
// Idempotency-Key) is what actually protects against that here, same as flights.
router.post("/bookings", requireIdempotencyKey, validateBody(hotelBookingSchema), async (req, res, next) => {
  try {
    const { offerId, guests, contact } = req.body;

    const offer = await Offers.get(offerId, req.tenant.agencyId);
    if (!offer) throw Errors.NotFound("Offer");
    if (new Date(offer.expires_at) < new Date()) throw Errors.OfferExpired(offer.id);

    // Atomic, race-safe idempotency — see repositories/index.js
    // createOrGetExisting and flights.routes.js for the equivalent flow.
    // Especially important here: LetsFG's own warning is that a blindly
    // retried hotel booking call double-books AND double-charges the 5%
    // reservation fee, so this needs to be airtight, not best-effort.
    const requestHash = hashRequestBody(req.body);
    const { booking, isNew, hashMismatch } = await Bookings.createOrGetExisting({
      agencyId: req.tenant.agencyId,
      offerId: offer.id,
      type: "hotel",
      idempotencyKey: req.idempotencyKey,
      supplierCode: offer.supplier_code,
      travelerIds: [],
      correlationId: uuid(),
      requestHash,
    });

    if (!isNew) {
      if (hashMismatch) throw Errors.IdempotencyKeyReused(req.idempotencyKey);
      return res.status(200).json(await toHotelBookingResponse(booking));
    }

    // Explicit created -> pending, same as flights.routes.js — genesis
    // record before the supplier call actually happens.
    await Bookings.transition(booking.id, "pending", { actor: "system", reason: "calling supplier" });

    const supplier = getHotelSupplier(offer.supplier_code);
    let supplierResult;
    try {
      supplierResult = await supplier.book(offer.supplier_offer_ref, guests, contact);
    } catch (err) {
      // Same fix as flights.routes.js: a timeout on the call that STARTS
      // the async booking job doesn't mean the job wasn't created — LetsFG
      // may have accepted it and just failed to return booking_job_id in
      // time. Classify rather than assume 'failed'. (Note: the /cancel
      // 'failed' status set later in this file, from a polled job status of
      // 'failed', is different — that's the supplier's own conclusive
      // answer, not an ambiguous timeout, so it correctly stays 'failed'.)
      const failureStatus = classifyBookingFailure(err);
      await Bookings.transition(booking.id, failureStatus, { actor: "system", reason: err.message });
      await Bookings.recordSupplierAudit(booking.id, offer.supplier_code, { guests, contact }, { error: err.message }, failureStatus);
      throw err;
    }

    await Bookings.recordSupplierAudit(booking.id, offer.supplier_code, { guests, contact }, supplierResult.raw, "processing");

    // Async booking job — store the job ref as supplier_reference for now so
    // GET /bookings/:id knows what to poll. It gets overwritten with the
    // real confirmation_number once the job succeeds (see below).
    // NOTE: pending -> pending isn't a real transition (already pending from
    // above); this just attaches the job ref via a metadata-only update.
    // The actual status stays 'pending' until GET resolves it.
    const updated = await Bookings.attachSupplierReference(booking.id, supplierResult.supplierJobRef);
    await HotelBookingDetails.upsert(booking.id, { supplierJobRef: supplierResult.supplierJobRef, guests, reservationFeeStatus: "pending" });

    res.status(202).json(await toHotelBookingResponse(updated));
  } catch (err) {
    next(err);
  }
});

// GET /v1/hotels/bookings/:bookingId — poll booking job / confirmation (T-055, T-057)
router.get("/bookings/:bookingId", async (req, res, next) => {
  try {
    const booking = await Bookings.get(req.params.bookingId, req.tenant.agencyId);
    if (!booking) throw Errors.NotFound("Booking");

    if (booking.status === "pending" && booking.supplier_reference) {
      const supplier = getHotelSupplier(booking.supplier_code);
      const live = await supplier.getBooking(booking.supplier_reference);

      // Same shared mapper flights uses (domain/bookingState.js) — LetsFG's
      // 'succeeded'/'failed' job statuses go through the same synonym table
      // rather than a second, separately-maintained if/else here.
      const mapped = mapBookingState({ rawStatus: live.status, reference: live.confirmationNumber });

      if (mapped === "confirmed") {
        const updated = await Bookings.transition(booking.id, "confirmed", {
          supplierReference: live.confirmationNumber || booking.supplier_reference,
          actor: "system",
          reason: "hotel booking job succeeded",
        });
        await HotelBookingDetails.upsert(booking.id, {
          confirmationNumber: live.confirmationNumber,
          payLink: live.payLink,
          balanceDueBy: live.balanceDueBy,
          cancellationTerms: live.cancellationTerms,
          reservationFeeAmount: live.reservationFeeAmount,
          reservationFeeStatus: "charged",
        });
        return res.json(await toHotelBookingResponse(updated));
      }
      if (mapped === "failed") {
        const updated = await Bookings.transition(booking.id, "failed", { actor: "system", reason: "hotel booking job failed" });
        await HotelBookingDetails.upsert(booking.id, { reservationFeeStatus: "failed" });
        return res.json(await toHotelBookingResponse(updated));
      }
      // mapped === 'pending' (still processing, or an unrecognized status —
      // never assumed confirmed) — fall through and return current state.
    }

    res.json(await toHotelBookingResponse(booking));
  } catch (err) {
    next(err);
  }
});

// POST /v1/hotels/bookings/:bookingId/cancel — cancel per supplier policy (T-056)
router.post("/bookings/:bookingId/cancel", async (req, res, next) => {
  try {
    const booking = await Bookings.get(req.params.bookingId, req.tenant.agencyId);
    if (!booking) throw Errors.NotFound("Booking");
    if (booking.status !== "confirmed") {
      throw Errors.ValidationFailed(`Booking ${booking.id} is '${booking.status}', not 'confirmed' — nothing to cancel yet.`);
    }

    const simulate = req.query.simulate === "true";

    if (!simulate) {
      // confirmed -> cancel_requested -> cancelled, per the state machine —
      // not a direct confirmed->cancelled jump. This matters: if the
      // process crashes between initiating cancellation and the supplier
      // confirming it, the booking is visibly 'cancel_requested', not
      // silently still 'confirmed' or wrongly already 'cancelled'.
      await Bookings.transition(booking.id, "cancel_requested", { actor: req.tenant.apiClientId, reason: "cancellation requested via API" });
    }

    const supplier = getHotelSupplier(booking.supplier_code);
    let result;
    try {
      result = await supplier.cancel(booking.supplier_reference, { simulate });
    } catch (err) {
      if (!simulate) {
        await Bookings.transition(booking.id, "failed", { actor: "system", reason: `cancellation attempt failed: ${err.message}` });
      }
      throw err;
    }

    if (!simulate) {
      await Bookings.transition(booking.id, "cancelled", { actor: "system", reason: "supplier confirmed cancellation" });
    }

    res.json({ bookingId: booking.id, simulate, status: result.status, refundAmount: result.refundAmount });
  } catch (err) {
    next(err);
  }
});

async function toHotelBookingResponse(booking) {
  const details = await HotelBookingDetails.get(booking.id);
  return {
    bookingId: booking.id,
    status: booking.status, // pending | confirmed | failed | cancelled — never set to confirmed without a real confirmation_number, same principle as P0-2 on flights
    confirmationNumber: details?.confirmation_number || null,
    payLink: details?.pay_link || null,
    balanceDueBy: details?.balance_due_by || null,
    reservationFeeStatus: details?.reservation_fee_status || null,
    cancellationTerms: details?.cancellation_terms || null,
    createdAt: booking.created_at,
  };
}

module.exports = router;
