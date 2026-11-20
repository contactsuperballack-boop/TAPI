#!/usr/bin/env node
// Durable booking poller (Sprint 10.0). Asynchronous suppliers only ACCEPT a
// booking; the outcome arrives later. This worker polls those bookings with
// backoff so resolution no longer depends on a client calling GET.
//
//   node src/scripts/pollBookings.js --once      one pass, then exit (cron-friendly)
//   node src/scripts/pollBookings.js             loop every BOOKING_POLL_INTERVAL_MS (default 15000)
//
// Safety: a Postgres advisory lock guarantees one active poller; a failed supplier call never
// changes booking state; after BOOKING_MAX_POLL_ATTEMPTS the booking is escalated to
// reconciliation_required so a human owns it. Never run tests against a production DB.
require("dotenv").config();
const db = require("../db");
const { Bookings } = require("../repositories");
const { getSupplier } = require("../services/supplierRegistry");
const { pollOne } = require("../services/bookingSync");
const { recoverOrphan } = require("../services/submissionRecovery");
const { writeAuditEvent } = require("../middleware/auditLog");

const LOCK_KEY = 875309002; // "tapi:poll-bookings" — distinct from reconcile's 875309001; do not reuse
const INTERVAL_MS = Number(process.env.BOOKING_POLL_INTERVAL_MS) || 15_000;
const BATCH = Number(process.env.BOOKING_POLL_BATCH) || 50;
const once = process.argv.includes("--once");
let stopping = false;

const ORPHAN_AFTER_MIN = Number(process.env.SUBMISSION_ORPHAN_AFTER_MINUTES) || 3; // longer than any in-flight supplier call

async function recoverPass() {
  const orphans = await Bookings.findSubmissionOrphans(ORPHAN_AFTER_MIN, 25);
  for (const booking of orphans) {
    if (stopping) break;
    const r = await recoverOrphan(booking, { Bookings, getSupplier });
    console.log(JSON.stringify({ event: "submission_orphan", bookingId: booking.id, supplier: booking.supplier_code, action: r.action, error: r.error }));
  }
}

async function pass() {
  await recoverPass();
  const due = await Bookings.findDueForPolling(BATCH);
  const summary = {};
  for (const booking of due) { // sequential on purpose: bounded supplier load, no self-races
    if (stopping) break;
    const r = await pollOne(booking, { Bookings, getSupplier });
    summary[r.action] = (summary[r.action] || 0) + 1;
    console.log(JSON.stringify({ event: "booking_polled", bookingId: booking.id, supplier: booking.supplier_code, action: r.action, error: r.error }));
    if (r.action === "escalated") {
      await writeAuditEvent({ agencyId: booking.agency_id, actor: "booking-poller", action: "RECONCILIATION_FLAGGED", resourceType: "booking", resourceId: booking.id, metadata: { reason: "polling exhausted" } });
    }
  }
  console.log(JSON.stringify({ event: "poll_pass_complete", due: due.length, summary }));
}

async function main() {
  const lockClient = await db.pool.connect();
  const { rows } = await lockClient.query("SELECT pg_try_advisory_lock($1) AS acquired", [LOCK_KEY]);
  if (!rows[0].acquired) {
    console.log("[poll-bookings] another poller holds the lock — exiting");
    lockClient.release();
    await db.pool.end();
    return;
  }
  const stop = () => { stopping = true; };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    do {
      await pass();
      if (once || stopping) break;
      await new Promise((r) => setTimeout(r, INTERVAL_MS));
    } while (!stopping);
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    lockClient.release();
    await db.pool.end();
  }
}

main().catch((err) => { console.error("[poll-bookings] fatal:", err); process.exit(1); });
