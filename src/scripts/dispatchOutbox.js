#!/usr/bin/env node
// Outbox dispatcher (Sprint 10.4). `--once` for cron, otherwise loops every OUTBOX_INTERVAL_MS (default 5000).
// Default handler writes an audit event; escalations (reconciliation_required) are flagged for operators.
// Extension point: add handlers (traveller email via services/notify, ops alerts, webhooks) keyed by event type.
require("dotenv").config();
const db = require("../db");
const { Outbox } = require("../repositories");
const { dispatchBatch } = require("../services/outboxDispatcher");
const { writeAuditEvent } = require("../middleware/auditLog");
const { settleOrder } = require("../services/settlementService");
const { getPaymentProvider } = require("../services/paymentProviderRegistry");
const dbq = require("../db");

const LOCK_KEY = 875309003; // "tapi:outbox" — distinct from reconcile (…001) and poller (…002)
const INTERVAL_MS = Number(process.env.OUTBOX_INTERVAL_MS) || 5000;
const once = process.argv.includes("--once");
let stopping = false;

// Every booking outcome may change what should happen to the customer's money. Settlement is state-derived and
// idempotent, so running it on every event (and again on retry) is safe. If it throws, the outbox retries the event.
async function settleForBookingEvent(row) {
  const { rows } = await dbq.query("SELECT order_id FROM bookings WHERE id=$1", [row.booking_id]);
  if (rows[0] && rows[0].order_id) await settleOrder(rows[0].order_id, { provider: getPaymentProvider() });
}

const handlers = {
  "booking.reconciliation_required": async (row) => {
    await settleForBookingEvent(row); // holds money, or escalates if an authorisation is about to lapse
    // Audit writes are idempotent enough for an ops flag; a duplicate flag is harmless.
    await writeAuditEvent({ agencyId: row.agency_id, actor: "outbox", action: "BOOKING_NEEDS_ATTENTION", resourceType: "booking", resourceId: row.booking_id, metadata: row.payload });
  },
  "booking.*": async (row) => {
    await settleForBookingEvent(row);
    await writeAuditEvent({ agencyId: row.agency_id, actor: "outbox", action: "BOOKING_EVENT", resourceType: "booking", resourceId: row.booking_id, metadata: { event: row.event_type, ...row.payload } });
  },
};

async function main() {
  const lock = await db.pool.connect();
  const { rows } = await lock.query("SELECT pg_try_advisory_lock($1) AS ok", [LOCK_KEY]);
  if (!rows[0].ok) { console.log("[outbox] another dispatcher holds the lock — exiting"); lock.release(); await db.pool.end(); return; }
  process.on("SIGTERM", () => { stopping = true; });
  process.on("SIGINT", () => { stopping = true; });
  try {
    do {
      const batch = await Outbox.claimBatch(25);
      const r = await dispatchBatch(batch, { Outbox, handlers });
      console.log(JSON.stringify({ event: "outbox_pass", claimed: batch.length, ...r }));
      if (once || stopping) break;
      await new Promise((res) => setTimeout(res, INTERVAL_MS));
    } while (!stopping);
  } finally {
    await lock.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    lock.release(); await db.pool.end();
  }
}
main().catch((e) => { console.error("[outbox] fatal:", e); process.exit(1); });
