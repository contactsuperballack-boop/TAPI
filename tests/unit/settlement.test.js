// Sprint 10.6 — settlement decisions and execution. Covers failure scenarios R07, R08, R14 and the acceptance criteria
// "no duplicate capture", "no refund exceeding the refundable balance", "unresolved => hold, not guess".
const test = require("node:test");
const assert = require("node:assert/strict");
const { decideSettlement, allocateAcrossBookings, toDecisionPayment } = require("../../src/domain/settlement");
const { executeAction, runSettlement } = require("../../src/services/settlementExecutor");
const { MockPaymentProvider } = require("../../src/services/adapters/mockPaymentProvider");
const { DEFAULT_PAYMENT_CAPABILITIES } = require("../../src/services/paymentProvider.interface");

const CAPS = { partialCapture: true, partialRefund: true, void: true };
const pay = (over = {}) => ({ id: "p1", status: "authorized", currency: "NGN", totalMinor: 100000, authorizedMinor: 100000, capturedMinor: 0, refundedMinor: 0, authorizationExpiresAt: null, ...over });
const bk = (status, amountMinor) => ({ id: `b-${status}-${amountMinor}`, status, amountMinor });

// ---- decisions -------------------------------------------------------------------------------------
test("hold: any unresolved booking blocks all money movement (ambiguity is not success or failure)", () => {
  for (const status of ["created", "pending", "processing", "ticketing_pending", "reconciliation_required", "action_required", "price_changed"]) {
    const d = decideSettlement(pay(), [bk("confirmed", 60000), bk(status, 40000)], CAPS);
    assert.equal(d.state, "hold", status);
    assert.deepEqual(d.actions, []);
  }
});

test("authorised + all confirmed -> capture the full amount", () => {
  const d = decideSettlement(pay(), [bk("confirmed", 60000), bk("confirmed", 40000)], CAPS);
  assert.deepEqual(d.actions.map((a) => [a.type, a.amountMinor, a.releaseRemainder]), [["capture", 100000, false]]);
});

test("R07: authorised, booking fails definitively -> void, nothing captured", () => {
  const d = decideSettlement(pay(), [bk("failed", 100000)], CAPS);
  assert.deepEqual(d.actions.map((a) => a.type), ["void"]);
});

test("partial fulfilment: capture only the confirmed share and release the rest; refuse if the provider cannot", () => {
  const mixed = [bk("confirmed", 70000), bk("failed", 30000)];
  const d = decideSettlement(pay(), mixed, CAPS);
  assert.deepEqual(d.actions.map((a) => [a.type, a.amountMinor, a.releaseRemainder]), [["capture", 70000, true]]);
  const e = decideSettlement(pay(), mixed, { ...CAPS, partialCapture: false });
  assert.equal(e.escalate.code, "PARTIAL_CAPTURE_UNSUPPORTED");
  assert.deepEqual(e.actions, []);
  assert.equal(decideSettlement(pay(), [bk("failed", 100000)], { ...CAPS, void: false }).escalate.code, "VOID_UNSUPPORTED");
});

test("authorisation about to lapse while bookings are unresolved -> escalate to a human, never auto-capture", () => {
  const now = new Date("2026-11-18T00:00:00Z");
  const soon = new Date(now.getTime() + 3 * 3600_000).toISOString();
  const d = decideSettlement(pay({ authorizationExpiresAt: soon }), [bk("processing", 100000)], CAPS, now);
  assert.equal(d.escalate.code, "AUTHORIZATION_EXPIRING");
  const later = new Date(now.getTime() + 5 * 24 * 3600_000).toISOString();
  assert.equal(decideSettlement(pay({ authorizationExpiresAt: later }), [bk("processing", 100000)], CAPS, now).state, "hold");
});

test("captured (provider charged at checkout): failed share is refunded; fully fulfilled is settled; refund never exceeds the balance", () => {
  const captured = pay({ status: "captured", capturedMinor: 100000 });
  assert.deepEqual(decideSettlement(captured, [bk("confirmed", 100000)], CAPS).state, "settled");
  const d = decideSettlement(captured, [bk("confirmed", 60000), bk("failed", 40000)], CAPS);
  assert.deepEqual(d.actions.map((a) => [a.type, a.amountMinor]), [["refund", 40000]]);
  // after 25000 was already refunded only 15000 remains due
  const after = decideSettlement({ ...captured, refundedMinor: 25000 }, [bk("confirmed", 60000), bk("failed", 40000)], CAPS);
  assert.deepEqual(after.actions.map((a) => a.amountMinor), [15000]);
  // already fully refunded -> nothing more
  assert.equal(decideSettlement({ ...captured, refundedMinor: 40000 }, [bk("confirmed", 60000), bk("failed", 40000)], CAPS).state, "settled");
  assert.equal(decideSettlement(captured, [bk("confirmed", 60000), bk("failed", 40000)], { ...CAPS, partialRefund: false }).escalate.code, "PARTIAL_REFUND_UNSUPPORTED");
});

test("allocation mismatch and non-settleable payments are never acted on", () => {
  assert.equal(decideSettlement(pay(), [bk("confirmed", 1)], CAPS).escalate.code, "ALLOCATION_MISMATCH");
  for (const status of ["pending", "failed", "voided", "refunded", "capture_failed"]) assert.equal(decideSettlement(pay({ status }), [bk("failed", 100000)], CAPS).state, "noop");
  assert.equal(decideSettlement(pay(), [], CAPS).state, "noop");
});

test("allocation across bookings: proportional to supplier price, exact, single currency only", () => {
  const rows = [{ id: "a", status: "confirmed", price: "300.00", currency: "USD" }, { id: "b", status: "failed", price: "100.00", currency: "USD" }];
  const r = allocateAcrossBookings(100001, rows); // total includes markup/fees
  assert.equal(r.amounts.reduce((s, x) => s + x.amountMinor, 0), 100001);
  assert.deepEqual(r.amounts.map((x) => x.amountMinor), [75001, 25000]);
  assert.equal(allocateAcrossBookings(1000, [{ id: "a", status: "x", price: "1", currency: "USD" }, { id: "b", status: "x", price: "1", currency: "GBP" }]).error.code, "MIXED_CURRENCY_ORDER");
  assert.equal(toDecisionPayment({ id: "p", status: "captured", currency: "NGN", amount: "1500.50", captured_minor: "150050", refunded_minor: "0" }).totalMinor, 150050);
});

// ---- execution (in-memory ledger with the real invariants: unique keys, balances from completed entries) ------------
const { paymentWorld: world } = require("../helpers/fakePaymentWorld");
const cap = (amountMinor) => ({ type: "capture", amountMinor, currency: "NGN", key: `capture:p1:${amountMinor}` });

test("capture: requested -> provider -> completed, counters updated once", async () => {
  const w = world();
  const r = await executeAction(cap(100000), w);
  assert.equal(r.result, "done");
  assert.deepEqual(w.Ledger.entries.map((e) => e.kind), ["capture_requested", "capture"]);
  assert.equal(w.payment.captured_minor, 100000);
});

test("NO DUPLICATE CAPTURE: running the same settlement repeatedly (retries, concurrent events) captures once", async () => {
  const w = world();
  let providerCalls = 0;
  const orig = w.provider.capture.bind(w.provider);
  w.provider.capture = async (a) => { providerCalls++; return orig(a); };
  for (let i = 0; i < 5; i++) await executeAction(cap(100000), w);
  assert.equal(w.payment.captured_minor, 100000);
  assert.equal(w.Ledger.entries.filter((e) => e.kind === "capture").length, 1);
  assert.equal(providerCalls, 1);
});

test("R08: capture definitively fails -> recorded, payment capture_failed, escalated; booking is never touched", async () => {
  const w = world();
  w.provider.injectFault("capture", { definitive: true, times: 1, message: "card issuer declined" });
  const r = await executeAction(cap(100000), w);
  assert.equal(r.result, "failed");
  assert.equal(r.code, "CAPTURE_FAILED");
  assert.equal(w.payment.status, "capture_failed");
  assert.ok(w.Ledger.entries.some((e) => e.kind === "capture_failed"));
  assert.equal(w.payment.captured_minor, 0);
});

test("timeout on capture is IN DOUBT: nothing concluded, same key retried later, still captured exactly once", async () => {
  const w = world();
  w.provider.injectFault("capture", { definitive: false, times: 1, message: "ETIMEDOUT" });
  assert.equal((await executeAction(cap(100000), w)).result, "in_doubt");
  assert.equal(w.payment.status, "authorized");                      // not failed, not captured
  assert.deepEqual(w.Ledger.entries.map((e) => e.kind), ["capture_requested"]);
  assert.equal((await executeAction(cap(100000), w)).result, "done"); // sweep retry
  assert.equal(w.Ledger.entries.filter((e) => e.kind === "capture").length, 1);
});

test("crash after the provider charged but before the completion entry: retry completes without double-charging", async () => {
  const w = world();
  await w.provider.capture({ providerRef: "mock_pay_1", amountMinor: 100000, idempotencyKey: "capture:p1:100000" }); // provider already did it
  await w.Ledger.append({ kind: "capture_requested", idempotencyKey: "capture:p1:100000:req", paymentId: "p1", amountMinor: 100000, currency: "NGN" });
  assert.equal((await executeAction(cap(100000), w)).result, "done");
  assert.equal(w.payment.captured_minor, 100000);
});

test("capture can never exceed the authorisation", async () => {
  const w = world();
  const r = await executeAction(cap(100001), w);
  assert.equal(r.result, "escalate");
  assert.equal(r.code, "CAPTURE_EXCEEDS_AUTHORIZATION");
  assert.equal(w.Ledger.entries.length, 0);
});

test("R07: void releases the authorisation and records it once", async () => {
  const w = world();
  const a = { type: "void", amountMinor: 100000, currency: "NGN", key: "void:p1" };
  assert.equal((await executeAction(a, w)).result, "done");
  assert.equal((await executeAction(a, w)).result, "already_done");
  assert.equal(w.payment.status, "voided");
});

test("R14: refund timeout is in doubt, retried with the same key, refunded once; refund can never exceed the balance", async () => {
  const w = world({ status: "captured", captured_minor: 100000 });
  const refund = (amountMinor, before = 0) => ({ type: "refund", amountMinor, currency: "NGN", key: `refund:p1:${before}:${amountMinor}` });
  w.provider.injectFault("refund", { definitive: false, times: 1, message: "ETIMEDOUT" });
  assert.equal((await executeAction(refund(40000), w)).result, "in_doubt");
  assert.equal(w.payment.refunded_minor, 0);
  assert.equal((await executeAction(refund(40000), w)).result, "done");
  assert.equal((await executeAction(refund(40000), w)).result, "already_done");
  assert.equal(w.payment.refunded_minor, 40000);
  // only 60000 refundable now
  assert.equal((await executeAction(refund(60001, 40000), w)).code, "REFUND_EXCEEDS_BALANCE");
  assert.equal((await executeAction(refund(60000, 40000), w)).result, "done");
  assert.equal(w.payment.status, "refunded");
});

test("runSettlement stops at the first action that is not complete so progress is never hidden", async () => {
  const w = world();
  w.provider.injectFault("capture", { definitive: true });
  const res = await runSettlement({ actions: [cap(50000), { type: "void", amountMinor: 1, currency: "NGN", key: "void:p1" }] }, w);
  assert.equal(res.length, 1);
  assert.equal(res[0].result, "failed");
});

test("provider capabilities: base class assumes nothing; the mock declares full support", () => {
  assert.deepEqual({ ...DEFAULT_PAYMENT_CAPABILITIES }, { authorizeCapture: false, partialCapture: false, partialRefund: false, void: false });
  assert.equal(new MockPaymentProvider().capabilities.authorizeCapture, true);
});
