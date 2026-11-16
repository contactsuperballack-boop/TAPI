// Sprint 1 hardening: mobility.routes.js previously defined its transition
// rules as a bare inline object at module scope, with the guard check and
// error-throwing duplicated inline in the route handler (and a fresh
// `require("../domain/errors").ApiError` call every time it needed to throw
// one). domain/bookingStateMachine.js already established the pattern this
// codebase uses for booking state: a single source of truth, an explicit
// state list, a dedicated error class, and an assert function routes call
// into rather than checking membership themselves. Mirroring that pattern
// here so mobility bookings are guarded the same way flights/hotels/orders
// are — not a parallel, less-rigorous convention.

const STATES = ["pending", "confirmed", "boarded", "cancelled"];
const TERMINAL_STATES = new Set(["boarded", "cancelled"]);

const TRANSITIONS = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["boarded", "cancelled"],
  boarded: [],
  cancelled: [],
};

class InvalidMobilityTransitionError extends Error {
  constructor(from, to) {
    super(`Invalid mobility booking transition: '${from}' -> '${to}'`);
    this.code = "INVALID_BOOKING_TRANSITION";
    this.from = from;
    this.to = to;
  }
}

/** Throws InvalidMobilityTransitionError if `from` -> `to` isn't legal. No-op if valid. */
function assertValidTransition(from, to) {
  if (!STATES.includes(to)) throw new InvalidMobilityTransitionError(from, to);
  const allowed = TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) throw new InvalidMobilityTransitionError(from, to);
}

function isTerminal(status) {
  return TERMINAL_STATES.has(status);
}

module.exports = { STATES, TERMINAL_STATES, TRANSITIONS, InvalidMobilityTransitionError, assertValidTransition, isTerminal };
