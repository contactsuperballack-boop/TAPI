// Sprint 10.4 — crash-window recovery and transactional outbox. Pure unit tests (no DB, no network).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { recoverOrphan } = require("../../src/services/submissionRecovery");
const { dispatchBatch } = require("../../src/services/outboxDispatcher");
const { outboxEventFor, nextDeliveryDelayMs, MAX_DELIVERY_ATTEMPTS } = require("../../src/domain/outbox");
const { assertFlightSupplier, DEFAULT_CAPABILITIES, FlightSupplier } = require("../../src/services/flightSupplier.interface");

const SRC = (p) => fs.readFileSync(path.join(__dirname, "../../", p), "utf8");

function fakeBookings() {
  const calls = { accepted: [], transitions: [], bumps: [] };
  return {
    calls,
    async recordSupplierAcceptance(id, ref, opts) { calls.accepted.push({ id, ref, ...opts }); return { id, status: "processing", supplier_booking_id: ref }; },
    async transition(id, to, opts) { calls.transitions.push({ id, to, ...opts }); return { id, status: to }; },
    async bumpRecoveryAttempts(id) { calls.bumps.push(id); },
  };
}
const orphan = { id: "b1", supplier_code: "s", status: "pending", submission_key: "tapi-bk-b1", supplier_booking_id: null };
// A supplier that must never be asked to book during recovery.
const noRebook = (extra) => ({ book: () => { throw new Error("RECOVERY MUST NEVER RE-SUBMIT"); }, ...extra });

test("recovery: authoritative lookup finds the booking -> attach id and continue as processing", async () => {
  const B = fakeBookings();
  const supplier = noRebook({ capabilities: { lookupByKey: true }, findBookingByKey: async (k) => { assert.equal(k, "tapi-bk-b1"); return { supplierBookingRef: "sup-9" }; } });
  const r = await recoverOrphan(orphan, { Bookings: B, getSupplier: () => supplier });
  assert.equal(r.action, "recovered");
  assert.equal(B.calls.accepted[0].ref, "sup-9");
  assert.equal(B.calls.transitions.length, 0);
});

test("recovery: authoritative lookup finds nothing -> definitive failure (safe to retry with a new key)", async () => {
  const B = fakeBookings();
  const supplier = noRebook({ capabilities: { lookupByKey: true }, findBookingByKey: async () => null });
  const r = await recoverOrphan(orphan, { Bookings: B, getSupplier: () => supplier });
  assert.equal(r.action, "cleared_failed");
  assert.equal(B.calls.transitions[0].to, "failed");
});

test("recovery: a failed lookup (DNS/timeouts) changes nothing and is retried later", async () => {
  const B = fakeBookings();
  const supplier = noRebook({ capabilities: { lookupByKey: true }, findBookingByKey: async () => { throw new Error("EAI_AGAIN"); } });
  const r = await recoverOrphan(orphan, { Bookings: B, getSupplier: () => supplier });
  assert.equal(r.action, "lookup_failed");
  assert.equal(B.calls.transitions.length + B.calls.accepted.length, 0);
  assert.deepEqual(B.calls.bumps, ["b1"]);
});

test("recovery: supplier without key lookup -> escalate to a human with the key, never guess", async () => {
  const B = fakeBookings();
  const r = await recoverOrphan(orphan, { Bookings: B, getSupplier: () => noRebook({ capabilities: { lookupByKey: false } }) });
  assert.equal(r.action, "escalated");
  assert.equal(B.calls.transitions[0].to, "reconciliation_required");
  assert.equal(B.calls.transitions[0].metadata.submissionKey, "tapi-bk-b1");
});

test("recovery: unconfigured supplier is not touched", async () => {
  const B = fakeBookings();
  const r = await recoverOrphan(orphan, { Bookings: B, getSupplier: () => { throw new Error("not configured"); } });
  assert.equal(r.action, "lookup_failed");
  assert.equal(B.calls.transitions.length, 0);
});

test("contract: lookupByKey=true requires findBookingByKey(); defaults stay false", () => {
  assert.equal(DEFAULT_CAPABILITIES.lookupByKey, false);
  class Liar extends FlightSupplier { get capabilities() { return { ...DEFAULT_CAPABILITIES, lookupByKey: true }; } }
  assert.throws(() => assertFlightSupplier(new Liar(), "liar"), /findBookingByKey\(\) missing/);
});

// ---- outbox -------------------------------------------------------------------
test("outbox events: only notable states, one dedupe key per booking+state", () => {
  assert.deepEqual(outboxEventFor("b", "processing", "confirmed"), { eventType: "booking.confirmed", dedupeKey: "b:confirmed" });
  assert.equal(outboxEventFor("b", "created", "pending"), null);
  assert.equal(outboxEventFor("b", "pending", "processing"), null);
  assert.equal(outboxEventFor("b", "processing", "reconciliation_required").eventType, "booking.reconciliation_required");
});

test("outbox delivery backoff is capped", () => {
  assert.equal(nextDeliveryDelayMs(1), 10_000);
  assert.equal(nextDeliveryDelayMs(3), 40_000);
  assert.equal(nextDeliveryDelayMs(99), 10 * 60_000);
});

function fakeOutbox() {
  const log = { delivered: [], retry: [], dead: [] };
  return { log, async markDelivered(id) { log.delivered.push(id); }, async scheduleRetry(id, ms, e) { log.retry.push({ id, ms, e }); }, async markDead(id, e) { log.dead.push({ id, e }); } };
}

test("dispatch: success delivers; handler failure retries with backoff; exhaustion dead-letters; fallback handler used", async () => {
  const Outbox = fakeOutbox();
  const seen = [];
  const handlers = {
    "booking.confirmed": async (row) => { seen.push(row.id); },
    "booking.failed": async () => { throw new Error("mail down"); },
    "booking.*": async (row) => { seen.push(`fallback:${row.id}`); },
  };
  const rows = [
    { id: "1", event_type: "booking.confirmed", attempts: 1 },
    { id: "2", event_type: "booking.failed", attempts: 2 },
    { id: "3", event_type: "booking.failed", attempts: MAX_DELIVERY_ATTEMPTS },
    { id: "4", event_type: "booking.cancelled", attempts: 1 },
  ];
  const r = await dispatchBatch(rows, { Outbox, handlers });
  assert.deepEqual(r, { delivered: 2, retried: 1, dead: 1 });
  assert.deepEqual(seen, ["1", "fallback:4"]);
  assert.equal(Outbox.log.retry[0].ms, 20_000);
  assert.equal(Outbox.log.dead[0].id, "3");
});

test("dispatch: an event type nobody handles is retried then dead-lettered, never silently dropped", async () => {
  const Outbox = fakeOutbox();
  const r = await dispatchBatch([{ id: "x", event_type: "weird.event", attempts: MAX_DELIVERY_ATTEMPTS }], { Outbox, handlers: {} });
  assert.equal(r.dead, 1);
});

// ---- wiring (source-level guards; routes cannot be executed without express/pg) -------------------
test("booking flow persists the submission intent BEFORE calling the supplier, and sends the server-owned key", () => {
  const src = SRC("src/services/flightBookingExecutor.js");
  const begin = src.indexOf("Bookings.beginSubmission(");
  const book = src.indexOf("supplier.book(");
  assert.ok(begin > 0 && book > begin, "beginSubmission must come before supplier.book");
  assert.match(src, /submissionKey = `tapi-bk-\$\{booking\.id\}`/);
  const bookCall = src.slice(src.indexOf("supplier.book("), src.indexOf("supplier.book(") + 400);
  assert.match(bookCall, /idempotencyKey: submissionKey/);
  assert.doesNotMatch(bookCall, /idempotencyKey: idempotencyKey|req\.idempotencyKey/); // the client's header must not be what the supplier sees
  assert.match(src, /recordSupplierAcceptance\(/);
  assert.doesNotMatch(src, /attachSupplierReference\(/);
  assert.match(SRC("src/routes/flights.routes.js"), /executeFlightBooking\(/); // the route delegates to it
});

test("repository: transition writes the outbox row in the same transaction; claim uses SKIP LOCKED", () => {
  const src = SRC("src/repositories/index.js");
  const t = src.slice(src.indexOf("async transition("), src.indexOf("async transition(") + 1800);
  assert.match(t, /withTransaction/);
  assert.match(t, /enqueueOutbox\(tx,/);
  assert.match(src, /FOR UPDATE SKIP LOCKED/);
  assert.match(src, /beginSubmission[\s\S]*withTransaction/);
});

test("migration 019 defines the intent columns and the outbox table", () => {
  const sql = SRC("src/db/migrations/019_submission_intent_and_outbox.sql");
  for (const t of ["submission_key", "submission_started_at", "recovery_attempts", "booking_outbox", "dedupe_key", "delivered_at", "dead_at"]) assert.match(sql, new RegExp(t));
  assert.match(sql, /dedupe_key\s+TEXT NOT NULL UNIQUE/);
});

test("poller runs orphan recovery before polling; workers use distinct advisory locks", () => {
  const poll = SRC("src/scripts/pollBookings.js");
  assert.ok(poll.indexOf("await recoverPass()") < poll.indexOf("findDueForPolling"));
  const keys = ["reconcile.js", "pollBookings.js", "dispatchOutbox.js"].map((f) => SRC(`src/scripts/${f}`).match(/LOCK_KEY = (\d+)/)[1]);
  assert.equal(new Set(keys).size, 3);
});
