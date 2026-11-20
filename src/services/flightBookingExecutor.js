// The flight booking flow, extracted from the route so it can be exercised with injected faults (crashes, supplier
// timeouts, duplicate requests) without HTTP or a database. The route is now a thin wrapper.
//
// Ordering is the safety property (each step is covered by a failure-scenario test):
//   1. everything that can be rejected WITHOUT side effects (offer, supplier config, sandbox-only fields) first,
//   2. the idempotent insert (one booking per idempotency key),
//   3. the submission intent is saved BEFORE the supplier is called,
//   4. a supplier failure is classified fail-safe (only provable refusals are 'failed'),
//   5. an accepted async booking has its supplier id + state saved in ONE transaction.
const { Errors } = require("../domain/errors");
const { mapBookingState } = require("../domain/bookingState");
const { classifyBookingOutcome } = require("../domain/bookingFailure");
const { classifyBookResult } = require("./bookingSync");

/**
 * @param {{agencyId:string, idempotencyKey:string, body:object}} input
 * @param {{Offers, Bookings, getSupplier:Function, hashRequestBody:Function, newId:Function, now?:()=>Date}} deps
 * @returns {Promise<{replay:true, booking:object} | {replay:false, httpStatus:number, booking:object, supplierRaw:any, async:boolean}>}
 */
async function executeFlightBooking({ agencyId, idempotencyKey, body }, deps) {
  const { Offers, Bookings, getSupplier, hashRequestBody, newId, now = () => new Date() } = deps;
  const { offerId, passengers, contact, travelerIds } = body;

  const offer = await Offers.get(offerId, agencyId);
  if (!offer) throw Errors.NotFound("Offer");
  if (new Date(offer.expires_at) < now()) throw Errors.OfferExpired(offer.id);

  // Resolve the supplier and validate request options BEFORE any booking row exists: a rejection here must not
  // leave a half-started booking behind.
  const supplier = getSupplier(offer.supplier_code);
  const caps = supplier.capabilities;
  if ((body.sandboxScenario || body.sandboxSpeed) && !caps.sandbox) {
    throw Errors.ValidationFailed("sandboxScenario/sandboxSpeed are only accepted when the supplier is running in sandbox mode.");
  }

  // One live booking per offer. A DIFFERENT idempotency key while a booking for this offer is open or ambiguous would
  // be a second supplier booking. (Same key = a retry, handled as a replay below.) Race-safe backstop: migration 021.
  const live = await Bookings.findLiveForOffer(offer.id);
  if (live && live.idempotency_key !== idempotencyKey) {
    throw Errors.BookingInProgressForOffer(`Booking ${live.id} for this offer is '${live.status}'. Wait for it to resolve instead of booking again.`);
  }

  let created;
  try {
    created = await Bookings.createOrGetExisting({
      agencyId, offerId: offer.id, type: "flight", idempotencyKey, supplierCode: offer.supplier_code,
      travelerIds: travelerIds || [], correlationId: newId(), requestHash: hashRequestBody(body),
    });
  } catch (err) {
    if (err && err.code === "23505" && /uniq_live_booking_per_offer/.test(err.constraint || err.message || "")) {
      throw Errors.BookingInProgressForOffer("Another booking for this offer was created at the same moment.");
    }
    throw err;
  }
  const { booking, isNew, hashMismatch } = created;
  if (!isNew) {
    if (hashMismatch) throw Errors.IdempotencyKeyReused(idempotencyKey);
    return { replay: true, booking }; // genuine retry or lost race: never call the supplier again
  }

  // Server-owned submission key, persisted with the intent BEFORE the supplier call.
  const submissionKey = `tapi-bk-${booking.id}`;
  await Bookings.beginSubmission(booking.id, submissionKey);

  let supplierResult;
  try {
    supplierResult = await supplier.book(offer.supplier_offer_ref, passengers, contact, {
      supplierSearchId: offer.payload && offer.payload.supplierSearchId,
      idempotencyKey: submissionKey,
      wantSeat: body.wantSeat,
      sandboxScenario: body.sandboxScenario,
      sandboxSpeed: body.sandboxSpeed,
    });
  } catch (err) {
    const failureStatus = classifyBookingOutcome(err);
    await Bookings.transition(booking.id, failureStatus, { actor: "system", reason: err.message });
    await Bookings.recordSupplierAudit(booking.id, offer.supplier_code, { passengers, contact }, { error: err.message }, failureStatus);
    throw err;
  }

  await Bookings.recordSupplierAudit(booking.id, offer.supplier_code, { passengers, contact }, supplierResult.raw, supplierResult.status);

  const { asyncBooking, httpStatus, initialStatus } = classifyBookResult(caps, supplierResult);
  const finalStatus = asyncBooking ? initialStatus : mapBookingState({
    rawStatus: supplierResult.status, reference: supplierResult.pnr, checkoutUrl: supplierResult.bookingUrl,
  });
  const updated = asyncBooking
    ? await Bookings.recordSupplierAcceptance(booking.id, supplierResult.supplierBookingRef)
    : await Bookings.transition(booking.id, finalStatus, {
        supplierReference: supplierResult.supplierBookingRef || supplierResult.pnr || null,
        checkoutUrl: supplierResult.bookingUrl || null,
        actor: "system",
        reason: "supplier responded",
      });
  return { replay: false, httpStatus, booking: updated, supplierRaw: supplierResult.raw, async: asyncBooking };
}

module.exports = { executeFlightBooking };
