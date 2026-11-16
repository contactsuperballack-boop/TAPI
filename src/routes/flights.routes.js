const express = require("express");
const { v4: uuid } = require("uuid");
const { getSupplier } = require("../services/supplierRegistry");
const { Searches, Offers, Bookings, hashRequestBody } = require("../repositories");
const { requireIdempotencyKey } = require("../middleware/idempotency");
const { Errors } = require("../domain/errors");
const { mapBookingState, classifyBookingFailure } = require("../domain/bookingState");
const { flightSearchSchema, flightBookingSchema, validateBody } = require("../validation/schemas");

const router = express.Router();
const SUPPLIER_CODE = "letsfg"; // MVP: single supplier. See supplierRegistry.js for the extension point.

// POST /v1/flights/search — kick off an async search (T-042, T-043)
router.post("/search", validateBody(flightSearchSchema), async (req, res, next) => {
  try {
    const { origin, destination, departDate, returnDate, passengers, cabinClass } = req.body;

    const supplier = getSupplier(SUPPLIER_CODE);
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

    const supplier = getSupplier(search.supplier_code || SUPPLIER_CODE);
    const result = await supplier.pollSearch(search.supplier_search_ref);

    if (result.status === "completed") {
      const stored = await Offers.bulkInsert(search.id, req.tenant.agencyId, "flight", SUPPLIER_CODE, result.offers);
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
    const { offerId, passengers, contact, travelerIds } = req.body;

    const offer = await Offers.get(offerId, req.tenant.agencyId);
    if (!offer) throw Errors.NotFound("Offer");
    if (new Date(offer.expires_at) < new Date()) throw Errors.OfferExpired(offer.id);

    // Atomic: the insert itself is the idempotency decision point (fixes the
    // check-then-insert race — see repositories/index.js createOrGetExisting).
    const requestHash = hashRequestBody(req.body);
    const { booking, isNew, hashMismatch } = await Bookings.createOrGetExisting({
      agencyId: req.tenant.agencyId,
      offerId: offer.id,
      type: "flight",
      idempotencyKey: req.idempotencyKey,
      supplierCode: offer.supplier_code,
      travelerIds: travelerIds || [],
      correlationId: uuid(),
      requestHash,
    });

    if (!isNew) {
      if (hashMismatch) throw Errors.IdempotencyKeyReused(req.idempotencyKey);
      // Genuine retry (or lost race) with the same body — never call the
      // supplier again, just return what's already there.
      return res.status(200).json(toBookingResponse(booking));
    }

    // Explicit created -> pending transition, right before the supplier
    // call actually happens — this is what the state machine's genesis
    // record (booking_state_transitions) is for: a real audit trail of
    // "row created" distinct from "call to supplier initiated", not the
    // booking silently starting mid-lifecycle.
    await Bookings.transition(booking.id, "pending", { actor: "system", reason: "calling supplier" });

    const supplier = getSupplier(offer.supplier_code);
    let supplierResult;
    try {
      supplierResult = await supplier.book(offer.supplier_offer_ref, passengers, contact);
    } catch (err) {
      // Fix for a confirmed bug: a supplier timeout is not proof the
      // booking failed (the supplier may have accepted it and just failed
      // to respond) — classify it, don't assume. 'reconciliation_required'
      // blocks a naive client retry the same way 'pending' does, but makes
      // clear this specific booking needs manual/automated follow-up before
      // anyone can be sure what happened at the supplier.
      const failureStatus = classifyBookingFailure(err);
      await Bookings.transition(booking.id, failureStatus, { actor: "system", reason: err.message });
      await Bookings.recordSupplierAudit(booking.id, offer.supplier_code, { passengers, contact }, { error: err.message }, failureStatus);
      throw err;
    }

    await Bookings.recordSupplierAudit(booking.id, offer.supplier_code, { passengers, contact }, supplierResult.raw, supplierResult.status);

    // Shared mapper (domain/bookingState.js) — the single source of truth
    // for "what does this supplier response actually mean", used identically
    // for flights and hotels. A successful HTTP response is never itself
    // treated as proof of a confirmed booking.
    const finalStatus = mapBookingState({
      rawStatus: supplierResult.status,
      reference: supplierResult.pnr || supplierResult.supplierBookingRef,
      checkoutUrl: supplierResult.bookingUrl,
    });

    // The state machine's own guard rejects 'confirmed' without a real
    // reference — mapBookingState() already enforces that upstream, but
    // this is the actual backstop, not just a convention two files agree on.
    const updated = await Bookings.transition(booking.id, finalStatus, {
      supplierReference: supplierResult.supplierBookingRef || supplierResult.pnr || null,
      checkoutUrl: supplierResult.bookingUrl || null,
      actor: "system",
      reason: "supplier responded",
    });
    res.status(201).json(toBookingResponse(updated));
  } catch (err) {
    next(err);
  }
});

// GET /v1/flights/bookings/:bookingId — status/PNR retrieval (T-047)
router.get("/bookings/:bookingId", async (req, res, next) => {
  try {
    const booking = await Bookings.get(req.params.bookingId, req.tenant.agencyId);
    if (!booking) throw Errors.NotFound("Booking");

    // If still pending, reconcile against the supplier rather than trusting
    // our own stale row (T-047: synchronize supplier status and expose
    // internal booking state).
    if (booking.status === "pending" && booking.supplier_reference) {
      const supplier = getSupplier(booking.supplier_code);
      const live = await supplier.getBooking(booking.supplier_reference);
      if (live.status === "confirmed" || live.pnr) {
        const updated = await Bookings.transition(booking.id, "confirmed", {
          supplierReference: live.pnr || booking.supplier_reference,
          actor: "system",
          reason: "reconciled on GET poll",
        });
        return res.json(toBookingResponse(updated));
      }
    }

    res.json(toBookingResponse(booking));
  } catch (err) {
    next(err);
  }
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
