const { v4: uuid } = require("uuid");
const { getBusSupplier } = require("../services/supplierRegistry");
const { Searches, Offers, Bookings, BusBookingDetails, hashRequestBody } = require("../repositories");
const { requireIdempotencyKey } = require("../middleware/idempotency");
const { Errors } = require("../domain/errors");
const { mapBookingState, classifyBookingFailure } = require("../domain/bookingState");
const { busSearchSchema, busBookingSchema, validateBody } = require("../validation/schemas");

const express = require("express");
const router = express.Router();
const SUPPLIER_CODE = process.env.BUS_SUPPLIER_CODE || "mock_bus";

router.post("/search", validateBody(busSearchSchema), async (req, res, next) => {
  try {
    const supplier = getBusSupplier(SUPPLIER_CODE);
    const { supplierSearchRef } = await supplier.search(req.body);
    const search = await Searches.create({ agencyId: req.tenant.agencyId, type: "bus", criteria: req.body, supplierSearchRef });
    res.status(202).json({ searchId: search.id, status: "processing", pollUrl: `/v1/buses/search/${search.id}` });
  } catch (err) { next(err); }
});

router.get("/search/:searchId", async (req, res, next) => {
  try {
    const search = await Searches.get(req.params.searchId, req.tenant.agencyId);
    if (!search || search.type !== "bus") throw Errors.NotFound("Search");
    if (search.status === "completed") {
      const offers = await Offers.listBySearchId(search.id, req.tenant.agencyId);
      return res.json({ searchId: search.id, status: "completed", offers: offers.map((o) => ({ offerId: o.id, ...o.payload })) });
    }
    if (search.status === "failed") return res.json({ searchId: search.id, status: "failed" });
    const result = await getBusSupplier(search.supplier_code || SUPPLIER_CODE).pollSearch(search.supplier_search_ref);
    if (result.status === "completed") {
      const stored = await Offers.bulkInsert(search.id, req.tenant.agencyId, "bus", SUPPLIER_CODE, result.offers || []);
      await Searches.markCompleted(search.id);
      return res.json({ searchId: search.id, status: "completed", offers: stored.map((o) => ({ offerId: o.id, ...o.payload })) });
    }
    if (result.status === "failed") { await Searches.markFailed(search.id); return res.json({ searchId: search.id, status: "failed" }); }
    res.json({ searchId: search.id, status: "processing" });
  } catch (err) { next(err); }
});

router.get("/offers/:offerId", async (req, res, next) => {
  try {
    const offer = await Offers.get(req.params.offerId, req.tenant.agencyId);
    if (!offer || offer.type !== "bus") throw Errors.NotFound("Offer");
    if (new Date(offer.expires_at) < new Date()) throw Errors.OfferExpired(offer.id);
    res.json({ offerId: offer.id, ...offer.payload });
  } catch (err) { next(err); }
});

router.post("/offers/:offerId/validate", async (req, res, next) => {
  try {
    const offer = await Offers.get(req.params.offerId, req.tenant.agencyId);
    if (!offer || offer.type !== "bus") throw Errors.NotFound("Offer");
    if (new Date(offer.expires_at) < new Date()) throw Errors.OfferExpired(offer.id);
    const result = await getBusSupplier(offer.supplier_code).validateOffer(offer.supplier_offer_ref);
    res.json({ offerId: offer.id, valid: result.valid, offer: result.offer });
  } catch (err) { next(err); }
});

router.post("/bookings", requireIdempotencyKey, validateBody(busBookingSchema), async (req, res, next) => {
  try {
    const { offerId, passengers, contact, pickupPoint, dropoffPoint } = req.body;
    const offer = await Offers.get(offerId, req.tenant.agencyId);
    if (!offer || offer.type !== "bus") throw Errors.NotFound("Offer");
    if (new Date(offer.expires_at) < new Date()) throw Errors.OfferExpired(offer.id);
    const requestHash = hashRequestBody(req.body);
    const { booking, isNew, hashMismatch } = await Bookings.createOrGetExisting({ agencyId: req.tenant.agencyId, offerId: offer.id, type: "bus", idempotencyKey: req.idempotencyKey, supplierCode: offer.supplier_code, travelerIds: [], correlationId: uuid(), requestHash });
    if (!isNew) {
      if (hashMismatch) throw Errors.IdempotencyKeyReused(req.idempotencyKey);
      return res.status(200).json(await toBusBookingResponse(booking));
    }
    await Bookings.transition(booking.id, "pending", { actor: "system", reason: "calling bus supplier" });
    let supplierResult;
    try {
      supplierResult = await getBusSupplier(offer.supplier_code).book(offer.supplier_offer_ref, passengers, contact, { pickupPoint, dropoffPoint });
    } catch (err) {
      const failureStatus = classifyBookingFailure(err);
      await Bookings.transition(booking.id, failureStatus, { actor: "system", reason: err.message });
      await Bookings.recordSupplierAudit(booking.id, offer.supplier_code, { passengers, contact, pickupPoint, dropoffPoint }, { error: err.message }, failureStatus);
      throw err;
    }
    await Bookings.recordSupplierAudit(booking.id, offer.supplier_code, { passengers, contact, pickupPoint, dropoffPoint }, supplierResult.raw, supplierResult.status);
    const finalStatus = mapBookingState({ rawStatus: supplierResult.status, reference: supplierResult.confirmationNumber || supplierResult.supplierBookingRef, checkoutUrl: supplierResult.bookingUrl });
    const updated = await Bookings.transition(booking.id, finalStatus, { supplierReference: supplierResult.confirmationNumber || supplierResult.supplierBookingRef, checkoutUrl: supplierResult.bookingUrl, actor: "system", reason: "bus supplier responded" });
    await BusBookingDetails.upsert(booking.id, { passengers, pickupPoint, dropoffPoint, seatNumbers: supplierResult.seatNumbers, operatorBookingRef: supplierResult.confirmationNumber || supplierResult.supplierBookingRef, travelDate: offer.payload.departDate, origin: offer.payload.origin, destination: offer.payload.destination });
    res.status(201).json(await toBusBookingResponse(updated));
  } catch (err) { next(err); }
});

router.get("/bookings/:bookingId", async (req, res, next) => {
  try {
    const booking = await Bookings.get(req.params.bookingId, req.tenant.agencyId);
    if (!booking || booking.type !== "bus") throw Errors.NotFound("Booking");
    if (["pending", "processing"].includes(booking.status) && booking.supplier_reference) {
      const live = await getBusSupplier(booking.supplier_code).getBooking(booking.supplier_reference);
      const mapped = mapBookingState({ rawStatus: live.status, reference: live.confirmationNumber || live.supplierBookingRef });
      if (mapped !== booking.status) {
        const updated = await Bookings.transition(booking.id, mapped, { supplierReference: live.confirmationNumber || live.supplierBookingRef, actor: "system", reason: "reconciled on bus booking GET" });
        return res.json(await toBusBookingResponse(updated));
      }
    }
    res.json(await toBusBookingResponse(booking));
  } catch (err) { next(err); }
});

router.post("/bookings/:bookingId/cancel", async (req, res, next) => {
  try {
    const booking = await Bookings.get(req.params.bookingId, req.tenant.agencyId);
    if (!booking || booking.type !== "bus") throw Errors.NotFound("Booking");
    if (booking.status !== "confirmed") throw Errors.ValidationFailed(`Booking ${booking.id} is '${booking.status}', not 'confirmed' — nothing to cancel yet.`);
    await Bookings.transition(booking.id, "cancel_requested", { actor: req.tenant.apiClientId, reason: "bus cancellation requested via API" });
    const result = await getBusSupplier(booking.supplier_code).cancel(booking.supplier_reference);
    const updated = await Bookings.transition(booking.id, "cancelled", { actor: "system", reason: "bus supplier confirmed cancellation" });
    res.json({ ...(await toBusBookingResponse(updated)), supplierStatus: result.status });
  } catch (err) { next(err); }
});

async function toBusBookingResponse(booking) {
  const details = await BusBookingDetails.get(booking.id);
  return { bookingId: booking.id, status: booking.status, supplierReference: booking.supplier_reference, bookingUrl: booking.checkout_url || null, origin: details?.origin || null, destination: details?.destination || null, travelDate: details?.travel_date || null, pickupPoint: details?.pickup_point || null, dropoffPoint: details?.dropoff_point || null, seatNumbers: details?.seat_numbers || [], operatorBookingRef: details?.operator_booking_ref || null, createdAt: booking.created_at };
}

module.exports = router;
