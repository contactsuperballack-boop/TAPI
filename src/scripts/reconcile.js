#!/usr/bin/env node
// Reconciliation script (review §3: "Build reconciliation workers").
//
// HONEST SCOPING — read this before treating this as "the reconciliation
// system": this is a single-pass script, meant to be invoked by an external
// scheduler (cron, a Kubernetes CronJob, etc.), not a durable background
// worker. It does NOT have:
//   - A job queue (no retry persistence beyond what's already in the DB)
//   - A dead-letter queue (permanently-stuck items are logged and left in
//     'reconciliation_required' for a human, not moved anywhere)
//   - Alerting (see below — this prints to stdout/audit_events; nothing
//     pages anyone)
//
// Sprint 2 hardening: distributed locking WAS on this list — running two
// instances concurrently could double-process the same booking. Fixed via a
// Postgres advisory lock in main() below: a second invocation that starts
// while one is still running now detects the lock and exits immediately
// instead of reconciling the same bookings twice.
//
// What it DOES do, for real: finds bookings stuck in an intermediate state
// past a threshold, attempts to resolve reconciliation_required bookings by
// asking the supplier directly (reusing the exact same adapter methods the
// API routes use — no separate reconciliation-specific supplier logic),
// and records every attempt — successful or not — in
// booking_state_transitions so there's a real audit trail of what an
// automated pass tried and found.
require("dotenv").config();
const db = require("../db");
const { Bookings } = require("../repositories");
const { getSupplier, getHotelSupplier } = require("../services/supplierRegistry");
const { mapBookingState } = require("../domain/bookingState");
const { writeAuditEvent } = require("../middleware/auditLog");

const STUCK_THRESHOLD_MINUTES = Number(process.env.RECONCILE_STUCK_THRESHOLD_MINUTES) || 15;

async function reconcileOne(booking) {
  const log = { bookingId: booking.id, type: booking.type, status: booking.status };

  if (booking.status !== "reconciliation_required" || !booking.supplier_reference) {
    // Stuck in 'pending'/'processing'/'cancel_requested'/'refund_pending'
    // with no supplier reference to check against, or a state this script
    // doesn't attempt automated resolution for — flag for a human rather
    // than guessing.
    console.log(JSON.stringify({ ...log, action: "flagged_for_manual_review", reason: "no automated resolution path for this state" }));
    await writeAuditEvent({
      agencyId: booking.agency_id,
      actor: "reconcile-script",
      action: "RECONCILIATION_FLAGGED",
      resourceType: "booking",
      resourceId: booking.id,
      metadata: { status: booking.status, reason: "stuck past threshold, no automated path" },
    });
    return { ...log, action: "flagged" };
  }

  try {
    const supplier = booking.type === "flight" ? getSupplier(booking.supplier_code) : getHotelSupplier(booking.supplier_code);
    const live = await supplier.getBooking(booking.supplier_reference);
    const mapped = mapBookingState({
      rawStatus: live.status,
      reference: live.pnr || live.confirmationNumber,
    });

    if (mapped === "confirmed") {
      await Bookings.transition(booking.id, "confirmed", {
        supplierReference: live.pnr || live.confirmationNumber || booking.supplier_reference,
        actor: "reconcile-script",
        reason: "resolved: supplier confirms reservation exists",
      });
      console.log(JSON.stringify({ ...log, action: "resolved_confirmed" }));
      return { ...log, action: "resolved_confirmed" };
    }
    if (mapped === "failed") {
      await Bookings.transition(booking.id, "failed", {
        actor: "reconcile-script",
        reason: "resolved: supplier confirms no reservation exists",
      });
      console.log(JSON.stringify({ ...log, action: "resolved_failed" }));
      return { ...log, action: "resolved_failed" };
    }

    // Still ambiguous even after asking the supplier directly — this is
    // exactly the case that needs a human, not another automated guess.
    console.log(JSON.stringify({ ...log, action: "still_ambiguous", supplierStatus: live.status }));
    await writeAuditEvent({
      agencyId: booking.agency_id,
      actor: "reconcile-script",
      action: "RECONCILIATION_STILL_AMBIGUOUS",
      resourceType: "booking",
      resourceId: booking.id,
      metadata: { supplierStatus: live.status },
    });
    return { ...log, action: "still_ambiguous" };
  } catch (err) {
    console.error(JSON.stringify({ ...log, action: "reconciliation_attempt_failed", error: err.message }));
    await writeAuditEvent({
      agencyId: booking.agency_id,
      actor: "reconcile-script",
      action: "RECONCILIATION_ATTEMPT_FAILED",
      resourceType: "booking",
      resourceId: booking.id,
      metadata: { error: err.message },
    });
    return { ...log, action: "attempt_failed", error: err.message };
  }
}

async function main() {
  // Sprint 2 hardening: this script's own header used to document distributed
  // locking as a known, unaddressed gap ("running two instances concurrently
  // could double-process the same booking"). A Postgres advisory lock closes
  // that: if a second invocation starts while one is still running (e.g. a
  // cron overlap after a slow supplier call), it detects the lock is held
  // and exits immediately rather than reconciling the same stuck bookings
  // twice. The lock is session-scoped to lockClient's own connection and
  // held for the lifetime of this process — releasing it explicitly in
  // `finally` (rather than relying on process exit) means a future change
  // that reuses this connection for something else won't inherit a stale lock.
  const LOCK_KEY = 875309001; // arbitrary but stable — identifies "tapi:reconcile" specifically; do not reuse for another lock
  const lockClient = await db.pool.connect();
  const { rows: lockRows } = await lockClient.query("SELECT pg_try_advisory_lock($1) AS acquired", [LOCK_KEY]);
  if (!lockRows[0].acquired) {
    console.log("[reconcile] another reconciliation run currently holds the lock — skipping this invocation");
    lockClient.release();
    await db.pool.end();
    process.exit(0);
  }

  try {
    const stuck = await Bookings.findStuckInIntermediateState(STUCK_THRESHOLD_MINUTES);
    console.log(`[reconcile] found ${stuck.length} booking(s) stuck past ${STUCK_THRESHOLD_MINUTES}min`);

    const results = [];
    for (const booking of stuck) {
      // Sequential, not parallel — deliberately. The advisory lock above
      // protects against a second concurrent INVOCATION of this script;
      // this sequential loop is the separate, still-necessary protection
      // against self-inflicted races WITHIN one run.
      results.push(await reconcileOne(booking));
    }

    const summary = results.reduce((acc, r) => {
      acc[r.action] = (acc[r.action] || 0) + 1;
      return acc;
    }, {});
    console.log("[reconcile] summary:", JSON.stringify(summary));
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch((err) => {
      console.error("[reconcile] failed to release advisory lock (will auto-release when the connection closes):", err.message);
    });
    lockClient.release();
  }

  await db.pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error("[reconcile] fatal error:", err);
  process.exit(1);
});
