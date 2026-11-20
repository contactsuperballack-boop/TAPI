// Explicit booking state machine (review's highest-value item: "travel
// transactions are asynchronous and supplier responses may be ambiguous").
// Every status change in the codebase must go through assertValidTransition()
// — this is the single source of truth for what's allowed, not a convention
// routes are trusted to follow correctly on their own.

const STATES = [
  "created",              // row exists, nothing sent to the supplier yet
  "pending",              // supplier call in flight, or async job started
  "processing",           // supplier acknowledged, working on it (e.g. hotel job)
  "ticketing_pending",    // reservation/PNR held, ticket NOT yet issued (GDS-style suppliers) — never shown as booked
  "confirmed",            // supplier gave a real reference — see requiresSupplierReference
  "action_required",      // supplier handed back a checkout URL, no reference yet
  "price_changed",        // supplier repriced the offer during validate/book
  "failed",               // conclusive rejection — safe to retry with a NEW idempotency key
  "reconciliation_required", // ambiguous (timeout/unavailable) — NOT safe to retry blindly
  "cancel_requested",     // cancellation initiated, supplier hasn't confirmed yet
  "cancelled",            // supplier confirmed the cancellation
  "refund_pending",       // refund initiated with the payment provider
  "refunded",             // refund confirmed
  "refund_failed",        // refund attempt did not succeed
];

const TERMINAL_STATES = new Set(["failed", "cancelled", "refunded"]);

// The transition table. Keys are the CURRENT status; values are the set of
// statuses it's legal to move to. Anything not listed here is rejected.
const TRANSITIONS = {
  created: ["pending", "failed"],
  pending: ["processing", "ticketing_pending", "confirmed", "action_required", "price_changed", "failed", "reconciliation_required"],
  processing: ["ticketing_pending", "confirmed", "action_required", "price_changed", "failed", "reconciliation_required"],
  ticketing_pending: ["confirmed", "cancelled", "failed", "reconciliation_required"], // ticket issued -> confirmed; reservation voided/lapsed -> cancelled/failed
  action_required: ["confirmed", "cancelled", "failed"], // customer completes checkout -> confirmed; abandons -> cancelled/failed
  price_changed: ["pending", "cancelled", "failed"], // re-quote and retry, or give up
  reconciliation_required: ["confirmed", "failed", "cancelled"], // resolved by scripts/reconcile.js or manual operator action
  confirmed: ["cancel_requested", "refund_pending"], // refund_pending direct path covers payment-only refunds without a separate cancel step
  cancel_requested: ["cancelled", "refund_pending", "failed"], // 'failed' here means the cancellation attempt itself failed, not the booking
  cancelled: ["refund_pending"],
  refund_pending: ["refunded", "refund_failed"],
  refund_failed: ["refund_pending", "reconciliation_required"], // retry, or escalate to manual reconciliation
  failed: [], // terminal
  refunded: [], // terminal
};

class InvalidTransitionError extends Error {
  constructor(from, to) {
    super(`Invalid booking state transition: '${from}' -> '${to}'`);
    this.code = "INVALID_BOOKING_TRANSITION";
    this.from = from;
    this.to = to;
  }
}

/** Throws InvalidTransitionError if `from` -> `to` isn't a legal transition. No-op if valid. */
function assertValidTransition(from, to) {
  if (!STATES.includes(to)) {
    throw new InvalidTransitionError(from, to); // reject unknown target states outright, not just disallowed ones
  }
  const allowed = TRANSITIONS[from];
  if (!allowed) {
    throw new InvalidTransitionError(from, to); // from is unknown or terminal-with-no-entry
  }
  if (!allowed.includes(to)) {
    throw new InvalidTransitionError(from, to);
  }
}

/** Guard rule: "a booking cannot be marked confirmed without a supplier confirmation reference." */
function requiresSupplierReference(status) {
  return status === "confirmed";
}

function isTerminal(status) {
  return TERMINAL_STATES.has(status);
}

/** Statuses a stuck-booking detector should treat as "shouldn't sit here indefinitely." */
const INTERMEDIATE_STATES = ["pending", "processing", "ticketing_pending", "reconciliation_required", "cancel_requested", "refund_pending"];

module.exports = {
  STATES,
  TERMINAL_STATES,
  INTERMEDIATE_STATES,
  TRANSITIONS,
  InvalidTransitionError,
  assertValidTransition,
  requiresSupplierReference,
  isTerminal,
};
