// Regression tests for the Nov-2026 audit (audits/security-and-quality-audit.md). node:test, no DB, no network.
const test = require("node:test");
const assert = require("node:assert/strict");
const { executeApprovedBooking, RETRY_WINDOW_MS } = require("../../src/agent/bookingExecutor");
const { fromRow } = require("../../src/domain/approval");
const { errorHandler } = require("../../src/middleware/errorHandler");

const NOW = new Date("2026-11-15T12:00:00Z");
const consumedRow = (consumedAgoMs) => ({
  id: "ap1", offer_id: "off1", approved_price: 500, currency: "USD", tolerance_pct: 0, status: "consumed",
  expires_at: new Date(NOW.getTime() - 3 * 86_400_000), consumed_booking_id: null,
  consumed_at: consumedAgoMs == null ? null : new Date(NOW.getTime() - consumedAgoMs),
});
function deps(row) {
  const calls = { validate: 0, book: [] };
  return { calls, deps: {
    now: () => NOW,
    approvals: { get: async () => row, consume: async () => null, attachBooking: async () => {} },
    tapi: {
      validateFlightOffer: async () => { calls.validate++; return { valid: true, price: 900, currency: "USD" }; },
      bookFlight: async (body, key) => { calls.book.push(key); return { bookingId: "bk1", status: "pending" }; },
    } } };
}

test("retry of a consumed approval inside the window re-sends with the same key (crash/timeout recovery)", async () => {
  const { calls, deps: d } = deps(consumedRow(60_000));
  const r = await executeApprovedBooking({ agencyId: "a", approvalId: "ap1", kind: "flight", bookingBody: {} }, d);
  assert.equal(r.ok, true);
  assert.deepEqual(calls.book, ["agent-approval-ap1"]);
});

test("retry of a consumed approval AFTER the window is refused: no unvalidated booking days later", async () => {
  const { calls, deps: d } = deps(consumedRow(RETRY_WINDOW_MS + 1000));
  const r = await executeApprovedBooking({ agencyId: "a", approvalId: "ap1", kind: "flight", bookingBody: {} }, d);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "APPROVAL_RETRY_WINDOW_EXPIRED");
  assert.equal(calls.book.length, 0);
});

test("retry with no consumed_at (legacy row) fails closed", async () => {
  const { calls, deps: d } = deps(consumedRow(null));
  const r = await executeApprovedBooking({ agencyId: "a", approvalId: "ap1", kind: "flight", bookingBody: {} }, d);
  assert.equal(r.ok, false);
  assert.equal(calls.book.length, 0);
});

test("fromRow exposes consumedAt", () => {
  assert.ok(fromRow(consumedRow(1000)).consumedAt instanceof Date);
});

function run(err) {
  const out = {}; const res = { status(s) { out.status = s; return this; }, type() { return this; }, json(b) { out.body = b; return this; } };
  const orig = console.error; console.error = () => {}; try { errorHandler(err, { correlationId: "c", originalUrl: "/x" }, res, () => {}); } finally { console.error = orig; }
  return out;
}
test("malformed JSON body is a 400, not a 500", () => {
  const e = Object.assign(new SyntaxError("Unexpected token"), { status: 400, type: "entity.parse.failed", expose: true });
  const o = run(e); assert.equal(o.status, 400); assert.equal(o.body.code, "INVALID_REQUEST_BODY");
});
test("oversized body is a 413, not a 500", () => {
  const e = Object.assign(new Error("request entity too large"), { status: 413, type: "entity.too.large", expose: true });
  assert.equal(run(e).status, 413);
});
test("malformed UUID reaching Postgres (22P02) is a 400, not a 500, and leaks no SQL", () => {
  const e = Object.assign(new Error('invalid input syntax for type uuid: "x"'), { code: "22P02" });
  const o = run(e); assert.equal(o.status, 400); assert.ok(!/uuid|syntax/i.test(JSON.stringify(o.body)));
});
test("genuinely unknown errors stay 500 and generic", () => {
  const o = run(new Error("db password is hunter2")); assert.equal(o.status, 500); assert.ok(!JSON.stringify(o.body).includes("hunter2"));
});
