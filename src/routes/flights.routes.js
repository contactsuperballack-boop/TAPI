const express = require("express");
const { v4: uuid } = require("uuid");
const { getSupplier, defaultFlightSupplierCode } = require("../services/supplierRegistry");
const { syncBooking, supplierBookingId } = require("../services/bookingSync");
const { executeFlightBooking } = require("../services/flightBookingExecutor");
const { Searches, Offers, Bookings, hashRequestBody } = require("../repositories");
const { requireIdempotencyKey } = require("../middleware/idempotency");
const { Errors } = require("../domain/errors");
const { flightSearchSchema, flightBookingSchema, flightBookingAnswerSchema, validateBody } = require("../validation/schemas");

const router = express.Router();
// New searches run against defaultFlightSupplierCode() (env FLIGHT_SUPPLIER_CODE, default letsfg).
// Every later step (poll, offers, booking) uses the supplier recorded on the search/offer/booking,
// and supplier differences are read from supplier.capabilities, never from supplier names.

// POST /v1/flights/search — kick off an async search (T-042, T-043)
router.post("/search", validateBody(flightSearchSchema), async (req, res, next) => {
  try {
    const { origin, destination, departDate, returnDate, passengers, cabinClass } = req.body;

    const supplierCode = defaultFlightSupplierCode();
    const supplier = getSupplier(supplierCode);
    const { supplierSearchRef } = await supplier.search({
      origin,
      destination,
      departDate,
      returnDate,
      adults: passengers.adults,
      children: passengers.children,
      infants: passengers.infants,
      cabinClass,
    });

    const search = await Searches.create({
      agencyId: req.tenant.agencyId,
      type: "flight",
      criteria: req.body,
      supplierSearchRef,
      supplierCode,
    });

    res.status(202).json({ searchId: search.id, status: "processing", pollUrl: `/v1/flights/search/${search.id}` });
  } catch (err) {
    next(err);
  }
});

// GET /v1/flights/search/:searchId — poll results (T-043)
router.get("/search/:searchId", async (req, res, next) => {
  try {
    const search = await Searches.get(req.params.searchId, req.tenant.agencyId);
    if (!search) throw Errors.NotFound("Search");

    // P1-4 fix: a search that already completed (or failed) must return its
    // persisted offers, not just a bare status — a client polling after the
    // status flip previously got {status:'completed', offers: undefined}.
    if (search.status === "completed") {
      const stored = await Offers.listBySearchId(search.id, req.tenant.agencyId);
      return res.json({
        searchId: search.id,
        status: "completed",
        offers: stored.map((o) => ({ offerId: o.id, ...o.payload })),
      });
    }
    if (search.status === "failed") {
      return res.json({ searchId: search.id, status: "failed" });
    }

    const supplier = getSupplier(search.supplier_code);
    const result = await supplier.pollSearch(search.supplier_search_ref);

    if (result.status === "completed") {
      const stored = await Offers.bulkInsert(search.id, req.tenant.agencyId, "flight", search.supplier_code, result.offers);
      await Searches.markCompleted(search.id);
      return res.json({
        searchId: search.id,
        status: "completed",
        offers: stored.map((o) => ({ offerId: o.id, ...o.payload })),
      });
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

// GET /v1/flights/offers/:offerId — offer detail
router.get("/offers/:offerId", async (req, res, next) => {
  try {
    const offer = await Offers.get(req.params.offerId, req.tenant.agencyId);
    if (!offer) throw Errors.NotFound("Offer");
    if (new Date(offer.expires_at) < new Date()) throw Errors.OfferExpired(offer.id);
    res.json({ offerId: offer.id, ...offer.payload });
  } catch (err) {
    next(err);
  }
});

// POST /v1/flights/offers/:offerId/validate — reprice/unlock before booking (T-045)
router.post("/offers/:offerId/validate", async (req, res, next) => {
  try {
    const offer = await Offers.get(req.params.offerId, req.tenant.agencyId);
    if (!offer) throw Errors.NotFound("Offer");
    if (new Date(offer.expires_at) < new Date()) throw Errors.OfferExpired(offer.id);

    const supplier = getSupplier(offer.supplier_code);
    const result = await supplier.validateOffer(offer.supplier_offer_ref);
    res.json({ offerId: offer.id, valid: result.valid, offer: result.offer });
  } catch (err) {
    next(err);
  }
});

// POST /v1/flights/bookings — create booking (T-046, idempotent T-074, race-safe)
router.post("/bookings", requireIdempotencyKey, validateBody(flightBookingSchema), async (req, res, next) => {
  try {
    // The whole flow (ordering, idempotency, crash-safety, failure classification) lives in
    // services/flightBookingExecutor.js, where it is covered by the R01–R16 failure-scenario tests.
    const r = await executeFlightBooking(
      { agencyId: req.tenant.agencyId, idempotencyKey: req.idempotencyKey, body: req.body },
      { Offers, Bookings, getSupplier, hashRequestBody, newId: uuid }
    );
    if (r.replay) return res.status(200).json(toBookingResponse(r.booking));
    // 202 = accepted, outcome still to come (async supplier); 201 = the supplier answered synchronously.
    res.status(r.httpStatus).json({ ...toBookingResponse(r.booking), supplier: r.supplierRaw, async: r.async });
  } catch (err) {
    next(err);
  }
});

// GET /v1/flights/bookings/:bookingId — status, refreshed from the supplier while the booking is still open.
// Uses the same shared sync as the background poller, so the rules for what counts as
// confirmed/failed/needs-attention live in one place (domain/liveBookingState.js).
// A supplier outage during refresh never fails the read: the stored state is returned.
const OPEN_STATES = ["pending", "processing", "ticketing_pending", "reconciliation_required"];
router.get("/bookings/:bookingId", async (req, res, next) => {
  try {
    const booking = await Bookings.get(req.params.bookingId, req.tenant.agencyId);
    if (!booking) throw Errors.NotFound("Booking");
    if (OPEN_STATES.includes(booking.status) && supplierBookingId(booking)) {
      try {
        const { booking: updated, live } = await syncBooking(booking, { Bookings, getSupplier, actor: "system" });
        return res.json({ ...toBookingResponse(updated), supplierState: live.status, normalizedState: live.state, terminal: live.terminal, manualBooking: live.manualBooking, question: live.question, heldAmount: live.heldAmount, chargedAmount: live.chargedAmount, currency: live.currency, failureReason: live.failureReason, declineReason: live.declineReason, sandbox: live.raw && live.raw.sandbox === true });
      } catch (syncErr) {
        console.error(JSON.stringify({ event: "booking_refresh_failed", bookingId: booking.id, error: syncErr.message }));
        return res.json({ ...toBookingResponse(booking), refreshFailed: true });
      }
    }
    res.json(toBookingResponse(booking));
  } catch (err) { next(err); }
});

// POST /v1/flights/bookings/:bookingId/answer — answer the supplier's open question
// (suppliers with capabilities.supportsAnswer). The round value is echoed to prevent stale-answer races.
router.post("/bookings/:bookingId/answer", validateBody(flightBookingAnswerSchema), async (req, res, next) => {
  try {
    const booking = await Bookings.get(req.params.bookingId, req.tenant.agencyId);
    if (!booking) throw Errors.NotFound("Booking");
    const supplier = getSupplier(booking.supplier_code);
    if (!supplier.capabilities.supportsAnswer) throw Errors.NotSupported("This supplier does not ask booking questions.");
    if (!supplierBookingId(booking) || !["pending", "processing"].includes(booking.status)) {
      throw Errors.ValidationFailed("This booking has no answerable supplier question.");
    }
    const result = await supplier.answer(supplierBookingId(booking), req.body);
    await Bookings.recordSupplierAudit(booking.id, booking.supplier_code, req.body, result.raw, result.status);
    res.json({ bookingId: booking.id, answerStatus: result.status, message: "Answer submitted. Continue polling the booking for its updated state." });
  } catch (err) { next(err); }
});

// POST /v1/flights/bookings/:bookingId/stop — request supplier-side stop (capabilities.supportsStop).
router.post("/bookings/:bookingId/stop", async (req, res, next) => {
  try {
    const booking = await Bookings.get(req.params.bookingId, req.tenant.agencyId);
    if (!booking) throw Errors.NotFound("Booking");
    const supplier = getSupplier(booking.supplier_code);
    if (!supplier.capabilities.supportsStop) throw Errors.NotSupported("This supplier does not support stopping a booking in progress.");
    if (!supplierBookingId(booking) || !OPEN_STATES.includes(booking.status)) {
      throw Errors.ValidationFailed("This booking cannot be stopped in its current state.");
    }
    const result = await supplier.stop(supplierBookingId(booking));
    await Bookings.recordSupplierAudit(booking.id, booking.supplier_code, { action: "stop" }, result.raw, result.status);
    res.json({ bookingId: booking.id, stopStatus: result.status, message: "Stop request submitted. Poll the booking for its final state." });
  } catch (err) { next(err); }
});

function toBookingResponse(booking) {
  return {
    bookingId: booking.id,
    status: booking.status,
    supplierReference: booking.supplier_reference,
    bookingUrl: booking.checkout_url, // now persisted (migration 004) — survives past the initial response
    createdAt: booking.created_at,
  };
}

module.exports = router;
