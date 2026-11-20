// Loads an order's payment + bookings, allocates the payment across the bookings, decides and executes settlement.
// This is the ONLY place that turns booking outcomes into money movement. Called from the outbox (event-driven) and
// from the sweep (re-drives in-doubt actions, watches authorisation expiry).
const db = require("../db");
const { Payments, Ledger } = require("../repositories");
const { decideSettlement, allocateAcrossBookings, toDecisionPayment } = require("../domain/settlement");
const { runSettlement } = require("./settlementExecutor");
const { writeAuditEvent } = require("../middleware/auditLog");

async function loadInput(orderId) {
  const { rows: pay } = await db.query(
    `SELECT * FROM payments WHERE order_id=$1 AND status IN ('authorized','captured','capture_failed') ORDER BY created_at DESC LIMIT 1`, [orderId]);
  if (!pay[0]) return null;
  const { rows: bks } = await db.query(
    `SELECT b.id, b.status, o.price, o.currency FROM bookings b JOIN offers o ON o.id = b.offer_id WHERE b.order_id=$1 ORDER BY b.created_at, b.id`, [orderId]);
  return { payment: pay[0], bookings: bks };
}

async function escalate(payment, orderId, code, detail) {
  await writeAuditEvent({ agencyId: payment.agency_id, actor: "settlement", action: "SETTLEMENT_ESCALATION", resourceType: "payment", resourceId: payment.id, metadata: { orderId, code, detail } });
}

/** @returns {{state:string, results?:Array, escalated?:{code:string,detail:string}}} */
async function settleOrder(orderId, { provider, now = new Date() }) {
  const input = await loadInput(orderId);
  if (!input) return { state: "noop" };
  const dp = toDecisionPayment(input.payment);
  const alloc = allocateAcrossBookings(dp.totalMinor, input.bookings);
  if (alloc.error) { await escalate(input.payment, orderId, alloc.error.code, alloc.error.detail); return { state: "escalate", escalated: alloc.error }; }

  const decision = decideSettlement(dp, alloc.amounts, provider.capabilities, now);
  if (decision.escalate) { await escalate(input.payment, orderId, decision.escalate.code, decision.escalate.detail); return { state: "escalate", escalated: decision.escalate }; }
  if (!decision.actions.length) return { state: decision.state };

  const results = await runSettlement(decision, { payment: input.payment, provider, Ledger, Payments });
  const bad = results.find((r) => !["done", "already_done"].includes(r.result));
  if (bad && bad.result !== "in_doubt") {
    await escalate(input.payment, orderId, bad.code || "SETTLEMENT_FAILED", bad.error || bad.result);
    return { state: "escalate", results, escalated: { code: bad.code || "SETTLEMENT_FAILED", detail: bad.error || bad.result } };
  }
  return { state: bad ? "in_doubt" : "settled", results };
}

module.exports = { settleOrder, loadInput };
