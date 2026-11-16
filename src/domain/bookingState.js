// Reusable booking-state mapper.
//
// The core rule this exists to enforce: a successful HTTP response from a
// supplier's book() call is NOT proof that a booking exists. Suppliers can
// return a confirmed PNR, a booking reference, a checkout URL requiring
// further customer action, a bare "pending" status, an async job id, or an
// error — all inside a 200 OK. This function is the single place that maps
// whatever the supplier said onto TAPI's own status enum, so that mapping
// logic isn't duplicated (and doesn't silently drift) across the flights and
// hotels routes.
//
// Precedence, highest first:
//   1. An explicit reference (PNR / confirmation number) always wins -> confirmed,
//      regardless of what the status string says.
//   2. A checkout URL with no reference -> action_required.
//   3. Otherwise, normalize the supplier's status string against known
//      synonyms.
//   4. Anything unrecognized -> pending, never assumed confirmed. Silence or
//      an unfamiliar word from a supplier is not evidence of success.
const STATUS_SYNONYMS = {
  confirmed: "confirmed",
  booked: "confirmed",
  success: "confirmed",
  succeeded: "confirmed",

  failed: "failed",
  error: "failed",
  rejected: "failed",

  checkout_required: "action_required",
  action_required: "action_required",

  price_changed: "price_changed",
  repriced: "price_changed",

  cancelled: "cancelled",
  canceled: "cancelled",
};

const VALID_STATES = new Set([
  "pending",
  "confirmed",
  "failed",
  "cancelled",
  "price_changed",
  "action_required",
  // Not producible by mapBookingState itself — set explicitly by route code
  // when a supplier call times out or is unreachable (SupplierTimeout /
  // SupplierUnavailable), because that ambiguity ("did the supplier accept
  // this booking and just fail to respond?") is a different kind of
  // uncertainty than "the supplier told us something we don't recognize".
  // Listed here so callers validating against this set don't reject it.
  "reconciliation_required",
]);

/**
 * @param {object} input
 * @param {string} [input.rawStatus] - whatever status string the supplier returned
 * @param {string|null} [input.reference] - PNR / confirmation number / booking reference, if any
 * @param {string|null} [input.checkoutUrl] - a URL the customer must complete checkout at, if any
 * @returns {'pending'|'confirmed'|'failed'|'cancelled'|'price_changed'|'action_required'}
 */
function mapBookingState({ rawStatus, reference, checkoutUrl } = {}) {
  if (reference) return "confirmed";
  if (checkoutUrl) return "action_required";

  const normalized = String(rawStatus || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const mapped = STATUS_SYNONYMS[normalized];
  if (mapped && VALID_STATES.has(mapped)) return mapped;

  return "pending";
}

// Fix for confirmed bug: a supplier call timing out, or being unreachable,
// is NOT proof a booking failed — the supplier may have accepted it and
// simply failed to respond in time. Marking it 'failed' the same way a
// genuine rejection is marked invites a client to retry with a new
// idempotency key, which can create a duplicate reservation and a duplicate
// charge at the supplier. Only conclusive errors should map to 'failed';
// ambiguous ones need a distinct state that blocks a naive retry and
// signals "this needs reconciliation before we know what actually happened".
const AMBIGUOUS_SUPPLIER_ERROR_CODES = new Set(["SUPPLIER_TIMEOUT", "SUPPLIER_UNAVAILABLE"]);

/**
 * @param {Error & {code?: string}} err
 * @returns {'failed'|'reconciliation_required'}
 */
function classifyBookingFailure(err) {
  if (err && AMBIGUOUS_SUPPLIER_ERROR_CODES.has(err.code)) return "reconciliation_required";
  return "failed";
}

module.exports = { mapBookingState, classifyBookingFailure, VALID_STATES };
