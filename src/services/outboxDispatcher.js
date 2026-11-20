// At-least-once outbox delivery. Handlers MUST be idempotent (an event can be delivered twice, e.g. a crash after the
// handler succeeded but before markDelivered). Dependencies injected for unit testing.
const { MAX_DELIVERY_ATTEMPTS, nextDeliveryDelayMs } = require("../domain/outbox");

/**
 * @param {Array} rows claimed outbox rows (attempts already incremented by claimBatch)
 * @param {{[eventType:string]: (row:object)=>Promise<void>}} handlers exact event type, or "booking.*" fallback
 * @returns {Promise<{delivered:number, retried:number, dead:number}>}
 */
async function dispatchBatch(rows, { Outbox, handlers }) {
  const out = { delivered: 0, retried: 0, dead: 0 };
  for (const row of rows) {
    const handler = handlers[row.event_type] || handlers["booking.*"];
    try {
      if (!handler) throw new Error(`no handler for ${row.event_type}`);
      await handler(row);
      await Outbox.markDelivered(row.id);
      out.delivered++;
    } catch (err) {
      if (row.attempts >= MAX_DELIVERY_ATTEMPTS) { await Outbox.markDead(row.id, err.message); out.dead++; }
      else { await Outbox.scheduleRetry(row.id, nextDeliveryDelayMs(row.attempts), err.message); out.retried++; }
    }
  }
  return out;
}

module.exports = { dispatchBatch };
