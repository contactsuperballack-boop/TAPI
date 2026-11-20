// In-memory payment world with the REAL invariants: unique ledger keys, balances from completed entries,
// counters updated only when a completion entry is newly inserted. Shared by the settlement and failure-scenario tests.
const { MockPaymentProvider } = require("../../src/services/adapters/mockPaymentProvider");

function paymentWorld(paymentOver = {}) {
  const entries = [];
  const payment = { id: "p1", agency_id: "a1", order_id: "o1", provider_ref: "mock_pay_1", status: "authorized", authorized_minor: 100000, captured_minor: 0, refunded_minor: 0, voided_minor: 0, ...paymentOver };
  const Ledger = {
    entries,
    async findByKey(k) { return entries.find((e) => e.idempotencyKey === k) || null; },
    async append(e) { if (entries.some((x) => x.idempotencyKey === e.idempotencyKey)) return null; entries.push(e); return e; },
    async balances() {
      const sum = (kind) => entries.filter((e) => e.kind === kind).reduce((a, e) => a + e.amountMinor, 0);
      return { authorized: sum("authorization") || payment.authorized_minor, captured: sum("capture") + (payment.status === "captured" && !entries.some((e) => e.kind === "capture") ? payment.captured_minor : 0), refunded: sum("refund"), voided: sum("void") };
    },
  };
  const Payments = {
    async markCaptureFailed() { payment.status = "capture_failed"; },
    async applySettlementCompletion(id, { kind, entry }) {
      if (entries.some((x) => x.idempotencyKey === entry.idempotencyKey)) return { duplicate: true };
      entries.push({ ...entry, kind });
      if (kind === "capture") { payment.captured_minor += entry.amountMinor; payment.status = "captured"; }
      if (kind === "void") { payment.voided_minor += entry.amountMinor; payment.status = "voided"; }
      if (kind === "refund") { payment.refunded_minor += entry.amountMinor; if (payment.refunded_minor >= payment.captured_minor) payment.status = "refunded"; }
      return { duplicate: false };
    },
  };
  return { payment, Ledger, Payments, provider: new MockPaymentProvider({ webhookSecret: "x" }) };
}

module.exports = { paymentWorld };
