// Outbox rules (pure). Which state changes produce an event, and how delivery retries.
const NOTABLE = new Set(["confirmed", "failed", "reconciliation_required", "ticketing_pending", "cancelled", "price_changed", "action_required"]);

/** @returns {{eventType:string, dedupeKey:string}|null} */
function outboxEventFor(bookingId, fromStatus, toStatus) {
  if (!NOTABLE.has(toStatus)) return null;
  return { eventType: `booking.${toStatus}`, dedupeKey: `${bookingId}:${toStatus}` };
}

const MAX_DELIVERY_ATTEMPTS = Number(process.env.OUTBOX_MAX_ATTEMPTS) || 8;
const LEASE_MS = 60_000;

// Delivery backoff: 10s, 20s, 40s ... capped at 10 minutes.
function nextDeliveryDelayMs(attempts) {
  return Math.min(10_000 * 2 ** Math.max(0, attempts - 1), 10 * 60_000);
}

module.exports = { NOTABLE, outboxEventFor, MAX_DELIVERY_ATTEMPTS, LEASE_MS, nextDeliveryDelayMs };
