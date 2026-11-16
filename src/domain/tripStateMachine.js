// Trip and trip-item lifecycle for the TAPI Agent. This sits ABOVE TAPI's
// 13-state booking machine (domain/bookingStateMachine.js): the booking
// machine stays the source of truth for money-moving state, and trip items
// only mirror it via mapBookingStatusToItemStatus(). The agent never writes
// booking state itself.

const TRIP_STATES = [
  "draft", "researching", "itinerary_ready", "awaiting_approval", "booking",
  "booked", "partially_booked", "needs_attention", "cancelled", "completed",
];

const TRIP_TRANSITIONS = {
  draft: ["researching", "cancelled"],
  researching: ["itinerary_ready", "cancelled"],
  itinerary_ready: ["researching", "awaiting_approval", "cancelled"],
  awaiting_approval: ["itinerary_ready", "booking", "cancelled"],
  booking: ["booked", "partially_booked", "needs_attention", "itinerary_ready", "cancelled"], // itinerary_ready: nothing is in progress any more (request withdrawn / sent back for a new price)
  partially_booked: ["booking", "needs_attention", "cancelled", "booked"],
  needs_attention: ["booking", "itinerary_ready", "booked", "partially_booked", "cancelled"],
  booked: ["needs_attention", "completed", "cancelled"],
  cancelled: [],
  completed: [],
};

class InvalidTripTransitionError extends Error {
  constructor(from, to) {
    super(`Invalid trip state transition: '${from}' -> '${to}'`);
    this.code = "INVALID_TRIP_TRANSITION";
    this.from = from;
    this.to = to;
  }
}

function assertValidTripTransition(from, to) {
  if (!TRIP_STATES.includes(to) || !TRIP_TRANSITIONS[from] || !TRIP_TRANSITIONS[from].includes(to)) {
    throw new InvalidTripTransitionError(from, to);
  }
}

// TAPI booking status -> trip item status. Unknown statuses fail closed to
// reconciliation_required (never to confirmed).
function mapBookingStatusToItemStatus(bookingStatus) {
  switch (bookingStatus) {
    case "created":
    case "pending":
    case "processing":
      return "booking";
    case "confirmed":
      return "confirmed";
    case "action_required":
      return "action_required";
    case "failed":
      return "failed";
    case "cancel_requested":
      return "confirmed"; // still held until the supplier confirms the cancellation
    case "cancelled":
    case "refund_pending":
    case "refunded":
    case "refund_failed":
      return "cancelled";
    case "price_changed":
      return "selected"; // back to the user for a fresh approval at the new price
    case "reconciliation_required":
    default:
      return "reconciliation_required";
  }
}

// Derive the trip-level state from its items. Only bookable items count;
// items still proposed/selected mean the trip hasn't reached booking.
function deriveTripState(items) {
  const live = items.filter((i) => i.status !== "cancelled");
  if (live.length === 0) return null;
  const s = (x) => live.filter((i) => i.status === x).length;
  if (s("reconciliation_required") || s("failed") || s("action_required")) return "needs_attention";
  if (s("booking") || s("agent_requested") || s("agent_working")) return "booking"; // waiting on an agent counts as booking in progress
  const confirmed = s("confirmed");
  if (confirmed === live.length) return "booked";
  if (confirmed > 0) return "partially_booked";
  return null; // nothing booked yet: caller keeps its current state
}

// The planning-to-booking progression a trip moves through as the user acts. Returns the states to pass
// through to get from `from` to `to` (each hop is a legal TRIP_TRANSITIONS edge), or [] if `from` is
// already there, past it, or outside the linear flow (e.g. booked / needs_attention / cancelled).
const FORWARD_FLOW = ["draft", "researching", "itinerary_ready", "awaiting_approval", "booking"];
function pathForward(from, to) {
  const a = FORWARD_FLOW.indexOf(from), b = FORWARD_FLOW.indexOf(to);
  if (a === -1 || b === -1 || a >= b) return [];
  return FORWARD_FLOW.slice(a + 1, b + 1);
}

// When items fall back out of booking (agent request withdrawn, or sent back for re-approval) the trip must not
// keep saying "booking". Returns the state to step back to, or null to leave it.
const IN_PROGRESS = ["booking", "agent_requested", "agent_working", "confirmed", "action_required", "reconciliation_required", "failed"];
function regressTarget(status, items) {
  if (status !== "booking") return null;
  return (items || []).some((i) => IN_PROGRESS.includes(i.status)) ? null : "itinerary_ready";
}

module.exports = {
  regressTarget,
  pathForward,
  TRIP_STATES, TRIP_TRANSITIONS, InvalidTripTransitionError,
  assertValidTripTransition, mapBookingStatusToItemStatus, deriveTripState,
};
