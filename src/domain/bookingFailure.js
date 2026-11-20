// What does a failure while booking mean for the traveller's money and the item's state?
//
// The dangerous case is the one we cannot tell apart: the request may have reached the supplier and booked, with
// only the response lost (timeout, dropped connection, 5xx). Asking the traveller to approve again would then risk a
// DOUBLE booking (a new approval means a new idempotency key). So:
//   definitive  the supplier/TAPI refused it; nothing was booked. The item goes back to the traveller (or is marked failed).
//   ambiguous   we cannot know. The item goes to "reconciliation_required"; the SAME approval may be re-sent for a
//               short window (same idempotency key, so a retry cannot double-book); after that a person resolves it.
//
// DEFAULT policy (confirm with the supplier's real behaviour once LetsFG is verified in sandbox):
//   definitive: HTTP 400, 404, 410, 422, and the known conflict codes SOLD_OUT, OFFER_EXPIRED, PRICE_CHANGED
//   ambiguous : everything else: 5xx, 408, 429, network errors, timeouts, and anything unrecognised.
const DEFINITIVE_STATUSES = new Set([400, 404, 410, 422]);
const DEFINITIVE_CODES = { SOLD_OUT: "failed", OFFER_EXPIRED: "failed", PRICE_CHANGED: "selected" };

function classifyBookingFailure(err) {
  const code = (err && err.code) || "UNKNOWN";
  const status = err && Number.isInteger(err.status) ? err.status : null;
  if (DEFINITIVE_CODES[code]) return { kind: "definitive", code, itemStatus: DEFINITIVE_CODES[code], status };
  if (status !== null && DEFINITIVE_STATUSES.has(status)) return { kind: "definitive", code, itemStatus: "selected", status };
  return { kind: "ambiguous", code, itemStatus: "reconciliation_required", status };
}

// Plain-language text for the traveller. Never includes supplier payloads or internals.
function failureMessage(c) {
  if (c.kind === "ambiguous") return "We could not confirm this booking yet. Please do not approve it again: we are checking with the supplier so you are not booked twice.";
  if (c.code === "SOLD_OUT") return "That option sold out before it could be booked. Nothing was booked.";
  if (c.code === "OFFER_EXPIRED") return "That offer expired before it could be booked. Nothing was booked.";
  if (c.code === "PRICE_CHANGED") return "The supplier changed the price. Nothing was booked. Review the new price and approve again.";
  return "The supplier did not accept this booking. Nothing was booked. Check the traveller's details and approve again.";
}

// FAIL-SAFE status classifier for the booking executor. Unlike the legacy string classifier in bookingState.js
// (which treats ANY unrecognised error as a definite failure), this one only concludes "nothing was booked" for
// errors that PROVE it: a supplier 4xx refusal, a known conflict code, or TAPI's own pre-flight validation. Anything
// else (timeouts, 5xx, dropped connections, and unexpected exceptions such as a parse error AFTER the supplier
// replied) is ambiguous, because the supplier may have booked. Ambiguous -> reconciliation, never a blind retry.
const DEFINITIVE_BOOKING_CODES = new Set(["SUPPLIER_REJECTED", "SOLD_OUT", "OFFER_EXPIRED", "PRICE_CHANGED", "VALIDATION_FAILED"]);
function classifyBookingOutcome(err) {
  const code = err && err.code;
  if (DEFINITIVE_BOOKING_CODES.has(code)) return "failed";
  const status = err && (Number.isInteger(err.status) ? err.status : Number.isInteger(err.httpStatus) ? err.httpStatus : null);
  if (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) return "failed";
  return "reconciliation_required";
}

module.exports = { classifyBookingFailure, classifyBookingOutcome, failureMessage, DEFINITIVE_STATUSES, DEFINITIVE_BOOKING_CODES };
