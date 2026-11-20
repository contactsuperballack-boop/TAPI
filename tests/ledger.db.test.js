// Integration tests for the money ledger, FX quotes and settlement repositories against REAL Postgres.
// NOT YET RUN by the author (no Postgres in the authoring environment) — CI's `integration` job is the first run.
const { resetDatabase, seedAgency, closeDb } = require("./setup");

let db, Searches, Offers, Bookings, Orders, Payments, Ledger, FxQuotes, agencyId, n = 0;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  await resetDatabase();
  ({ agencyId } = await seedAgency("Ledger Agency"));
  db = require("../src/db");
  ({ Searches, Offers, Bookings, Payments, Ledger, FxQuotes } = require("../src/repositories"));
});
afterAll(async () => { await closeDb(); });

async function newPayment({ status = "pending", amount = "1000.00", currency = "NGN" } = {}) {
  n++;
  const order = (await db.query(`INSERT INTO orders (agency_id, status, total_price, currency) VALUES ($1,'open',$2,$3) RETURNING *`, [agencyId, amount, currency])).rows[0];
  const { payment } = await Payments.createOrGetExisting({ agencyId, orderId: order.id, provider: "mock", amount, currency, idempotencyKey: `pk${n}` });
  await Payments.setProviderRef(payment.id, `mock_pay_${n}`);
  if (status !== "pending") await db.query(`UPDATE payments SET status=$2 WHERE id=$1`, [payment.id, status]);
  return (await db.query(`SELECT * FROM payments WHERE id=$1`, [payment.id])).rows[0];
}

test("ledger is append-only: UPDATE and DELETE are rejected by the database", async () => {
  const p = await newPayment();
  const e = await Ledger.append({ agencyId, orderId: p.order_id, paymentId: p.id, kind: "authorization", amountMinor: 100000, currency: "NGN", idempotencyKey: `t-immut-${p.id}` });
  await expect(db.query(`UPDATE ledger_entries SET amount_minor = 1 WHERE id=$1`, [e.id])).rejects.toThrow(/append-only/);
  await expect(db.query(`DELETE FROM ledger_entries WHERE id=$1`, [e.id])).rejects.toThrow(/append-only/);
});

test("ledger idempotency key is unique: a duplicate append is a no-op returning null", async () => {
  const p = await newPayment();
  const entry = { agencyId, orderId: p.order_id, paymentId: p.id, kind: "authorization", amountMinor: 5, currency: "NGN", idempotencyKey: `t-dup-${p.id}` };
  expect(await Ledger.append(entry)).not.toBeNull();
  expect(await Ledger.append(entry)).toBeNull();
});

test("authorisation webhook path: status, counters and ledger entry land together; a repeat is ignored", async () => {
  const p = await newPayment();
  const r1 = await Payments.markAuthorizedFromWebhook(p.id, { amountMinor: 100000, expiresAt: new Date(Date.now() + 7 * 86400e3), eventId: `ev-${p.id}` });
  expect(r1.payment.status).toBe("authorized");
  expect(r1.payment.capture_mode).toBe("manual");
  expect(Number(r1.payment.authorized_minor)).toBe(100000);
  const r2 = await Payments.markAuthorizedFromWebhook(p.id, { amountMinor: 100000, expiresAt: null, eventId: null });
  expect(r2.alreadyProcessed).toBe(true);
  expect((await Ledger.balances(p.id)).authorized).toBe(100000);
});

test("capture completion: counters move once; replays are duplicates; balances derive from the ledger", async () => {
  const p = await newPayment();
  await Payments.markAuthorizedFromWebhook(p.id, { amountMinor: 100000, expiresAt: null, eventId: null });
  const entry = { agencyId, orderId: p.order_id, paymentId: p.id, amountMinor: 70000, currency: "NGN", idempotencyKey: `capture:${p.id}:70000:done` };
  const a = await Payments.applySettlementCompletion(p.id, { kind: "capture", entry });
  const b = await Payments.applySettlementCompletion(p.id, { kind: "capture", entry });
  expect(a.duplicate).toBe(false);
  expect(b.duplicate).toBe(true);
  const row = (await db.query(`SELECT * FROM payments WHERE id=$1`, [p.id])).rows[0];
  expect(row.status).toBe("captured");
  expect(Number(row.captured_minor)).toBe(70000);
  expect(await Ledger.balances(p.id)).toEqual({ authorized: 100000, captured: 70000, voided: 0, refunded: 0 });
});

test("refund completion flips the payment to refunded only when the whole captured amount is back", async () => {
  const p = await newPayment();
  await Payments.markAuthorizedFromWebhook(p.id, { amountMinor: 100000, expiresAt: null, eventId: null });
  await Payments.applySettlementCompletion(p.id, { kind: "capture", entry: { agencyId, orderId: p.order_id, paymentId: p.id, amountMinor: 100000, currency: "NGN", idempotencyKey: `c-${p.id}` } });
  await Payments.applySettlementCompletion(p.id, { kind: "refund", entry: { agencyId, orderId: p.order_id, paymentId: p.id, amountMinor: 40000, currency: "NGN", idempotencyKey: `r1-${p.id}` } });
  expect((await db.query(`SELECT status FROM payments WHERE id=$1`, [p.id])).rows[0].status).toBe("captured");
  await Payments.applySettlementCompletion(p.id, { kind: "refund", entry: { agencyId, orderId: p.order_id, paymentId: p.id, amountMinor: 60000, currency: "NGN", idempotencyKey: `r2-${p.id}` } });
  expect((await db.query(`SELECT status FROM payments WHERE id=$1`, [p.id])).rows[0].status).toBe("refunded");
});

test("void completion sets voided; capture_failed is an allowed status", async () => {
  const p = await newPayment();
  await Payments.markAuthorizedFromWebhook(p.id, { amountMinor: 100000, expiresAt: null, eventId: null });
  await Payments.markCaptureFailed(p.id);
  expect((await db.query(`SELECT status FROM payments WHERE id=$1`, [p.id])).rows[0].status).toBe("capture_failed");
  const p2 = await newPayment();
  await Payments.markAuthorizedFromWebhook(p2.id, { amountMinor: 100000, expiresAt: null, eventId: null });
  await Payments.applySettlementCompletion(p2.id, { kind: "void", entry: { agencyId, orderId: p2.order_id, paymentId: p2.id, amountMinor: 100000, currency: "NGN", idempotencyKey: `v-${p2.id}` } });
  expect((await db.query(`SELECT status FROM payments WHERE id=$1`, [p2.id])).rows[0].status).toBe("voided");
});

test("webhook capture (automatic mode) records the ledger capture and captured_minor in the same transaction", async () => {
  const p = await newPayment({ amount: "1500.50" });
  await Payments.markCapturedAndOrderPaid(p.id, p.order_id, `ev-cap-${p.id}`);
  const row = (await db.query(`SELECT * FROM payments WHERE id=$1`, [p.id])).rows[0];
  expect(Number(row.captured_minor)).toBe(150050);
  expect((await Ledger.balances(p.id)).captured).toBe(150050);
});

test("settlement candidates: authorised payments, and captured ones owed a refund for a failed booking", async () => {
  const a = await newPayment(); await Payments.markAuthorizedFromWebhook(a.id, { amountMinor: 100000, expiresAt: null, eventId: null });
  const ids = (await Payments.findSettlementCandidates(100)).map((r) => r.id);
  expect(ids).toContain(a.id);
});

test("FX quote can be consumed exactly once, even under concurrency, and never after expiry", async () => {
  const now = new Date();
  const q = await FxQuotes.create(agencyId, { baseCurrency: "USD", quoteCurrency: "NGN", midRate: "1500.5", bufferBps: 100, source: "test", asOf: now, createdAt: now, expiresAt: new Date(now.getTime() + 600000) });
  const results = await Promise.all([1, 2, 3, 4, 5].map((i) => FxQuotes.consume(q.id, agencyId, `order:${i}`)));
  expect(results.filter(Boolean)).toHaveLength(1);
  const expired = await FxQuotes.create(agencyId, { baseCurrency: "USD", quoteCurrency: "NGN", midRate: "1500", bufferBps: 0, source: "test", asOf: now, createdAt: new Date(now.getTime() - 1200000), expiresAt: new Date(now.getTime() - 600000) });
  expect(await FxQuotes.consume(expired.id, agencyId, "late")).toBeNull();
  expect(await FxQuotes.get(q.id, "00000000-0000-4000-8000-000000000099")).toBeNull(); // tenant isolation
});

test("FX quote CHECKs: same-currency and out-of-range buffer rejected by the database", async () => {
  const now = new Date();
  const base = { baseCurrency: "USD", quoteCurrency: "NGN", midRate: "1", bufferBps: 0, source: "t", asOf: now, createdAt: now, expiresAt: new Date(now.getTime() + 1000) };
  await expect(FxQuotes.create(agencyId, { ...base, quoteCurrency: "USD" })).rejects.toThrow();
  await expect(FxQuotes.create(agencyId, { ...base, bufferBps: 5000 })).rejects.toThrow();
});
