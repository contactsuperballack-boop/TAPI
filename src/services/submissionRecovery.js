// Recovery for the crash window: TAPI began a supplier submission, then the process died (or the response was lost)
// before the supplier's booking id was saved. The booking sits in 'pending' with no supplier id.
//
// Hard rule: recovery NEVER re-submits the booking. The passenger payload is not retained for replay and a duplicate
// ticket costs more than a delayed one. It can only (a) discover the booking by its server-owned key, if the supplier
// offers an authoritative lookup, or (b) hand the booking to a human with the key recorded.
//
// Dependencies are injected so the safety logic is unit-testable.

/**
 * @returns {Promise<{action:'recovered'|'cleared_failed'|'escalated'|'lookup_failed', booking?:object, error?:string}>}
 */
async function recoverOrphan(booking, { Bookings, getSupplier }) {
  const actor = "submission-recovery";
  const key = booking.submission_key;
  let supplier;
  try { supplier = getSupplier(booking.supplier_code); } catch (err) {
    await Bookings.bumpRecoveryAttempts(booking.id);
    return { action: "lookup_failed", error: err.message };
  }

  if (supplier.capabilities.lookupByKey && key) {
    let found;
    try {
      found = await supplier.findBookingByKey(key);
    } catch (err) {
      // A failed lookup is not evidence either way. Leave the booking exactly as it is and try again later.
      await Bookings.bumpRecoveryAttempts(booking.id);
      return { action: "lookup_failed", error: err.message };
    }
    if (found && found.supplierBookingRef) {
      const updated = await Bookings.recordSupplierAcceptance(booking.id, found.supplierBookingRef, { actor, reason: "recovered supplier booking by submission key after interruption" });
      return { action: "recovered", booking: updated };
    }
    // Authoritative lookup says no booking was ever created => definitive failure; safe to retry with a NEW key.
    const failed = await Bookings.transition(booking.id, "failed", { actor, reason: "supplier confirms no booking exists for the submission key (never created)" });
    return { action: "cleared_failed", booking: failed };
  }

  // No authoritative lookup: we cannot know. Escalate with the key so an operator can check the supplier.
  const escalated = await Bookings.transition(booking.id, "reconciliation_required", {
    actor,
    reason: "submission outcome unknown after interruption; supplier cannot be queried by key. Check the supplier for the submission key before any retry.",
    metadata: { submissionKey: key || null },
  });
  return { action: "escalated", booking: escalated };
}

module.exports = { recoverOrphan };
