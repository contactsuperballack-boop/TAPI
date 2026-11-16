// The only path by which the agent may spend money. Order is fixed:
//   1. load the approval (tenant-scoped)
//   2. revalidate the offer with TAPI
//   3. checkApproval(): unexpired, same offer/currency, price not above ceiling
//   4. atomically consume the approval (single use)
//   5. book through TAPI with an idempotency key derived from the approval id
// Nothing here writes booking state; TAPI's state machine owns that.
const { checkApproval, fromRow } = require("../domain/approval");

function approvalIdempotencyKey(approvalId) {
  return `agent-approval-${approvalId}`; // same approval => same key => safe retry after a timeout
}

// deps: { approvals: {get, consume, attachBooking}, tapi, now? }
async function executeApprovedBooking({ agencyId, approvalId, kind, bookingBody }, deps) {
  const { approvals, tapi } = deps;
  const now = deps.now ? deps.now() : new Date();
  const approval = fromRow(await approvals.get(approvalId, agencyId));
  if (!approval) return { ok: false, reason: "NO_APPROVAL" };

  const key = approvalIdempotencyKey(approval.id);

  // Retry path: approval already consumed but the booking id never came back
  // (timeout / crash). Re-send with the SAME key; TAPI dedupes. No new spend.
  let livePrice;
  const isRetry = approval.status === "consumed" && !approval.consumedBookingId;
  if (!isRetry) {
    let verdict;
    try {
      verdict = kind === "flight" ? await tapi.validateFlightOffer(approval.offerId) : await tapi.validateHotelOffer(approval.offerId);
    } catch (err) {
      // TAPI signals these as HTTP errors (domain/errors.js), not as valid:false.
      if (err.code === "PRICE_CHANGED") return { ok: false, reason: "PRICE_CHANGED" };
      if (err.code === "OFFER_EXPIRED") return { ok: false, reason: "OFFER_EXPIRED" };
      if (err.code === "SOLD_OUT") return { ok: false, reason: "SOLD_OUT" };
      throw err; // unknown failure: do not book, do not consume the approval
    }
    const live = {
      offerId: approval.offerId, // TAPI validates by id, so the id echoes unless TAPI says otherwise
      price: verdict.price ?? verdict.totalPrice ?? verdict.offer?.price,
      currency: verdict.currency ?? verdict.offer?.currency,
      valid: verdict.valid !== false && verdict.status !== "invalid",
    };
    if (verdict.offerId) live.offerId = verdict.offerId;
    const check = checkApproval(approval, live, now);
    if (!check.ok) return check;
    livePrice = check.livePrice;

    const consumed = await approvals.consume(approval.id, agencyId);
    if (!consumed) return { ok: false, reason: "APPROVAL_ALREADY_USED_OR_EXPIRED" };
  }

  const book = kind === "flight" ? tapi.bookFlight : tapi.bookHotel;
  const booking = await book.call(tapi, { ...bookingBody, offerId: approval.offerId } /* approved offer always wins */, key);
  const bookingId = booking.bookingId || booking.id;
  if (bookingId) await approvals.attachBooking(approval.id, agencyId, bookingId);
  return { ok: true, booking, idempotencyKey: key, livePrice }; // livePrice is undefined on the retry path (no revalidation happened)
}

module.exports = { executeApprovedBooking, approvalIdempotencyKey };
