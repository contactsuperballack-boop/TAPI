// Supplier-agnostic interpretation of a supplier's LIVE booking state.
//
// Adapters normalise their own vocabulary into `live.state` (one of LIVE_STATES);
// this module decides what TAPI should do about it. It is pure (no I/O) so the
// safety rules can be tested exhaustively without a database or a supplier.
//
// Safety rules encoded here:
//   * 'confirmed' requires BOTH a confirmed live state AND an evidence reference
//     (PNR / ticket number). A "completed" supplier state with no evidence is
//     escalated, never trusted.
//   * 'failed' is only acted on when the supplier says it is definitive.
//   * 'needs_attention' always lands in reconciliation_required (a human owns it).
//   * Anything unknown is treated as still in progress — silence is not success.

const LIVE_STATES = ["in_progress", "ticketing_pending", "confirmed", "failed", "needs_attention"];
const ACTIVE = ["pending", "processing", "ticketing_pending", "reconciliation_required"];

/**
 * @param {{status:string, supplier_reference?:string|null}} booking
 * @param {{state?:string, pnr?:string|null, ticketNumbers?:string[], failureReason?:string|null, manualBooking?:boolean}} live
 * @returns {null | {to:string, supplierReference?:string, reason:string}}  null = no change
 */
function decideTransition(booking, live) {
  if (!ACTIVE.includes(booking.status)) return null;
  const state = LIVE_STATES.includes(live && live.state) ? live.state : "in_progress";
  const evidence = (live && live.pnr) || null;

  switch (state) {
    case "confirmed":
      if (!evidence) {
        return booking.status === "reconciliation_required"
          ? null
          : { to: "reconciliation_required", reason: "supplier reports completed but returned no PNR/ticket evidence" };
      }
      return { to: "confirmed", supplierReference: evidence, reason: "supplier completed the booking with evidence reference" };
    case "failed":
      return { to: "failed", reason: live.failureReason || "supplier reports the booking failed" };
    case "needs_attention":
      if (booking.status === "reconciliation_required") return null;
      return { to: "reconciliation_required", reason: live.manualBooking ? "supplier requires human fulfilment" : "supplier outcome needs attention" };
    case "ticketing_pending":
      if (["pending", "processing"].includes(booking.status)) return { to: "ticketing_pending", reason: "reservation held, ticket not yet issued" };
      return null;
    default: // in_progress
      if (booking.status === "pending") return { to: "processing", reason: "supplier is still processing" };
      return null;
  }
}

// Poll backoff: 15s, 30s, 60s ... capped at 15 minutes.
function nextPollDelayMs(attempts) {
  return Math.min(15_000 * 2 ** Math.max(0, attempts), 15 * 60_000);
}

module.exports = { LIVE_STATES, ACTIVE, decideTransition, nextPollDelayMs };
