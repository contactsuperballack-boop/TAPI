// Supplier-agnostic booking synchronisation, shared by the GET /bookings/:id
// route, the polling worker and the reconcile script. Dependencies are injected
// so the safety logic is unit-testable without a database or a supplier.
const { decideTransition, nextPollDelayMs } = require("../domain/liveBookingState");

const MAX_POLL_ATTEMPTS = Number(process.env.BOOKING_MAX_POLL_ATTEMPTS) || 40;

/** The id to ask the supplier about: its own booking id, falling back to the legacy single reference column. */
function supplierBookingId(booking) {
  return booking.supplier_booking_id || booking.supplier_reference;
}

/**
 * Ask the supplier for the live state and apply the safe transition, if any.
 * Throws if the supplier call fails (callers decide how to degrade) — a failed
 * poll never changes booking state.
 * @returns {{booking:object, live:object, changed:boolean}}
 */
async function syncBooking(booking, { Bookings, getSupplier, actor = "system" }) {
  const supplier = getSupplier(booking.supplier_code);
  const live = await supplier.getBooking(supplierBookingId(booking));
  const decision = decideTransition(booking, live);
  if (!decision) return { booking, live, changed: false };
  const updated = await Bookings.transition(booking.id, decision.to, {
    supplierReference: decision.supplierReference,
    actor,
    reason: decision.reason,
  });
  return { booking: updated, live, changed: true };
}

/**
 * One worker step for one booking: sync, then schedule the next poll with
 * backoff. When polling is exhausted and the booking is still not terminal it
 * is escalated to reconciliation_required so a human owns it.
 * @returns {{action:string, booking:object}}
 */
async function pollOne(booking, deps) {
  const { Bookings, now = () => Date.now() } = deps;
  const attempts = (booking.poll_attempts || 0) + 1;
  try {
    const result = await syncBooking(booking, { ...deps, actor: "booking-poller" });
    const terminal = ["confirmed", "failed", "cancelled"].includes(result.booking.status);
    if (terminal) {
      await Bookings.markPolled(booking.id, { attempts, nextPollAt: null });
      return { action: `resolved_${result.booking.status}`, booking: result.booking };
    }
    if (attempts >= MAX_POLL_ATTEMPTS && result.booking.status !== "reconciliation_required") {
      const escalated = await Bookings.transition(booking.id, "reconciliation_required", { actor: "booking-poller", reason: `polling exhausted after ${attempts} attempts without a terminal supplier state` });
      await Bookings.markPolled(booking.id, { attempts, nextPollAt: null });
      return { action: "escalated", booking: escalated };
    }
    await Bookings.markPolled(booking.id, { attempts, nextPollAt: new Date(now() + nextPollDelayMs(attempts)) });
    return { action: result.changed ? "advanced" : "still_pending", booking: result.booking };
  } catch (err) {
    // A failed poll is not evidence about the booking: leave state alone, back off, retry.
    await Bookings.markPolled(booking.id, { attempts, nextPollAt: new Date(now() + nextPollDelayMs(attempts)) });
    return { action: "poll_failed", booking, error: err.message };
  }
}

/**
 * Decide how a supplier's book() result is reported. A supplier that only
 * ACCEPTS the booking (asyncBooking) never yields 'confirmed' at this point.
 * @returns {{asyncBooking:boolean, httpStatus:number, initialStatus:string|null}}
 */
function classifyBookResult(capabilities, supplierResult) {
  const asyncBooking = Boolean(capabilities.asyncBooking && supplierResult && supplierResult.supplierBookingRef);
  return { asyncBooking, httpStatus: asyncBooking ? 202 : 201, initialStatus: asyncBooking ? "processing" : null };
}

module.exports = { supplierBookingId, syncBooking, pollOne, classifyBookResult, MAX_POLL_ATTEMPTS };
