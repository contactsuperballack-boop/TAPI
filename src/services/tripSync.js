const { Trips } = require("../repositories/trips");
const { deriveTripState, assertValidTripTransition, regressTarget } = require("../domain/tripStateMachine");

// After item statuses change, move the trip to the state its items imply (if that is a legal move).
async function syncTripStatus(agencyId, tripId) {
  const trip = await Trips.get(tripId, agencyId);
  if (!trip) return null;
  const items = await Trips.listItems(tripId, agencyId);
  const next = deriveTripState(items) || regressTarget(trip.status, items);
  if (next && next !== trip.status) {
    try { assertValidTripTransition(trip.status, next); await Trips.setStatus(tripId, agencyId, next); return next; } catch (_) { /* illegal jump: leave as is */ }
  }
  return trip.status;
}
module.exports = { syncTripStatus };
