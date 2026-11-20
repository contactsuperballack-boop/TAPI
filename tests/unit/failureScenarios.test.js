// Sprint 10 Gate-1 failure-scenario programme, R01–R16.
//
// HONESTY NOTE: these run against in-memory fakes that enforce the real state machine and the real idempotency rule.
// They prove the LOGIC (ordering, classification, decisions). They do NOT prove that Postgres, HTTP, process kills or
// real suppliers behave the same; those need the CI integration job and the manual go-live checklist. The
// traceability table in audits/sprint10-r01-r16-qualification.md states the evidence level per scenario.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { executeFlightBooking } = require("../../src/services/flightBookingExecutor");
const { recoverOrphan } = require("../../src/services/submissionRecovery");
const { syncBooking, pollOne } = require("../../src/services/bookingSync");
const { decideTransition } = require("../../src/domain/liveBookingState");
const { dispatchBatch } = require("../../src/services/outboxDispatcher");
const { decideSettlement } = require("../../src/domain/settlement");
const { runSettlement } = require("../../src/services/settlementExecutor");
const { executeApprovedBooking } = require("../../src/agent/bookingExecutor");
const { toModelView, assertNoSecrets } = require("../../src/agent/piiBoundary");
const { classifyBookingOutcome } = require("../../src/domain/bookingFailure");
const { makeBookings, makeSupplier, bookingDeps } = require("../helpers/fakeBookingWorld");
const { paymentWorld } = require("../helpers/fakePaymentWorld");

const BODY = { offerId: "off1", passengers: [{ firstName: "A" }], contact: { email: "a@b.c" } };
const book = (deps, key = "k1", body = BODY) => executeFlightBooking({ agencyId: "ag1", idempotencyKey: key, body }, deps);
const world = (mode, caps) => { const Bookings = makeBookings(); const supplier = makeSupplier({ mode, caps }); return { Bookings, supplier, deps: bookingDeps({ Bookings, supplier }) }; };
const onlyBooking = (w) => [...w.Bookings.rows.values()][0];
const SRC = (p) => fs.readFileSync(path.join(__dirname, "../../", p), "utf8");

// ---------------------------------------------------------------------------------------------------------- R01
test("R01: database unavailable before booking -> no supplier submission, at every pre-submission step", async () => {
  for (const method of ["createOrGetExisting", "beginSubmission"]) {
    const w = world("accept");
    w.Bookings.failNext(method);
    await assert.rejects(() => book(w.deps), /DB unavailable/);
    assert.equal(w.supplier.bookCalls.length, 0, method);
  }
  const w = world("accept");
  w.deps.Offers = { get: async () => { throw new Error("DB unavailable (offers)"); } };
  await assert.rejects(() => book(w.deps));
  assert.equal(w.supplier.bookCalls.length, 0);
});

test("R01 (found by this programme): a request rejected before submission leaves NO half-started booking behind", async () => {
  const w = world("accept");
  await assert.rejects(() => book(w.deps, "k1", { ...BODY, sandboxScenario: "success" }), (e) => e.code === "VALIDATION_FAILED");
  assert.equal(w.Bookings.rows.size, 0);
  assert.equal(w.supplier.bookCalls.length, 0);
  const w2 = world("accept");
  w2.deps.getSupplier = () => { throw Object.assign(new Error("not configured"), { code: "SUPPLIER_NOT_CONFIGURED" }); };
  await assert.rejects(() => book(w2.deps));
  assert.equal(w2.Bookings.rows.size, 0);
});

// ---------------------------------------------------------------------------------------------------------- R02
test("R02: DB fails after the supplier accepted -> booking is findable, never resubmitted, recovered by key or escalated", async () => {
  // (a) supplier cannot be queried by key -> a human owns it, with the key
  const a = world("accept");
  a.Bookings.failNext("recordSupplierAcceptance");
  await assert.rejects(() => book(a.deps), /DB unavailable/);
  const stuck = onlyBooking(a);
  assert.equal(stuck.status, "pending");
  assert.equal(stuck.submission_key, "tapi-bk-bk1");
  assert.equal(a.supplier.created, 1);
  const replay = await book(a.deps);                       // the client retries with the same key
  assert.equal(replay.replay, true);
  assert.equal(a.supplier.created, 1);                     // still exactly one supplier booking
  const r = await recoverOrphan(a.Bookings.get(stuck.id), { Bookings: a.Bookings, getSupplier: () => a.supplier });
  assert.equal(r.action, "escalated");
  assert.equal(a.Bookings.get(stuck.id).status, "reconciliation_required");
  assert.equal(a.Bookings.get(stuck.id).lastMetadata.submissionKey, "tapi-bk-bk1");
  assert.equal(a.supplier.created, 1);

  // (b) supplier supports authoritative lookup by key -> the booking is found and resumes, then confirms with a PNR
  const b = world("accept", { lookupByKey: true });
  b.Bookings.failNext("recordSupplierAcceptance");
  await assert.rejects(() => book(b.deps));
  const row = onlyBooking(b);
  assert.equal((await recoverOrphan(b.Bookings.get(row.id), { Bookings: b.Bookings, getSupplier: () => b.supplier })).action, "recovered");
  assert.equal(b.Bookings.get(row.id).status, "processing");
  assert.equal(b.Bookings.get(row.id).supplier_booking_id, "sup-1");
  b.supplier.live = { state: "confirmed", pnr: "PNR1" };
  const synced = await syncBooking(b.Bookings.get(row.id), { Bookings: b.Bookings, getSupplier: () => b.supplier });
  assert.equal(synced.booking.status, "confirmed");
  assert.equal(b.supplier.created, 1);
});

test("R02: DB fails while recording a supplier ERROR -> booking stays pending (visible to recovery), original error surfaces", async () => {
  const w = world("timeoutAfterAccept");
  w.Bookings.failNext("transition");
  await assert.rejects(() => book(w.deps), /DB unavailable/);
  assert.equal(onlyBooking(w).status, "pending");
  const r = await recoverOrphan(w.Bookings.get(onlyBooking(w).id), { Bookings: w.Bookings, getSupplier: () => w.supplier });
  assert.equal(r.action, "escalated");
  assert.equal(w.supplier.created, 1);
});

// ---------------------------------------------------------------------------------------------------------- R03
test("R03: DNS EAI_AGAIN -> never a duplicate booking (conservatively ambiguous; same-key retry replays)", async () => {
  const w = world("dns");
  await assert.rejects(() => book(w.deps), (e) => e.code === "SUPPLIER_UNAVAILABLE");
  assert.equal(onlyBooking(w).status, "reconciliation_required");
  assert.equal(w.supplier.created, 0);
  assert.equal((await book(w.deps)).replay, true);
  assert.equal(w.supplier.bookCalls.length, 1);            // the retry did not hit the supplier again
});

// ---------------------------------------------------------------------------------------------------------- R04
test("R04: supplier timeout after accepting -> ambiguous, reconcile; the retry never creates a second booking", async () => {
  const w = world("timeoutAfterAccept");
  await assert.rejects(() => book(w.deps), (e) => e.code === "SUPPLIER_TIMEOUT");
  assert.equal(onlyBooking(w).status, "reconciliation_required");
  assert.equal((await book(w.deps)).replay, true);
  assert.equal(w.supplier.created, 1);
  assert.equal(w.supplier.bookCalls.length, 1);
});

test("R04 (found by this programme): an UNEXPECTED error after the supplier replied is ambiguous, not 'failed'", async () => {
  const w = world("parseErrorAfterAccept");
  await assert.rejects(() => book(w.deps), TypeError);
  assert.equal(onlyBooking(w).status, "reconciliation_required"); // the legacy classifier would have said 'failed' and invited a duplicate
  assert.equal(w.supplier.created, 1);
});

test("failure classification is fail-safe: only provable refusals are definitive", () => {
  for (const e of [{ code: "SUPPLIER_REJECTED" }, { code: "SOLD_OUT" }, { status: 422 }, { httpStatus: 400 }, { code: "VALIDATION_FAILED" }]) assert.equal(classifyBookingOutcome(e), "failed", JSON.stringify(e));
  for (const e of [{ code: "SUPPLIER_TIMEOUT" }, { code: "SUPPLIER_UNAVAILABLE" }, { status: 500 }, { status: 408 }, { status: 429 }, new TypeError("x"), {}, null, undefined]) assert.equal(classifyBookingOutcome(e), "reconciliation_required", String(e && e.code));
  const w = world("reject");
  return assert.rejects(() => book(w.deps), (e) => e.code === "SUPPLIER_REJECTED").then(() => assert.equal(onlyBooking(w).status, "failed"));
});

// ---------------------------------------------------------------------------------------------------------- R05
test("No new supplier booking while the previous result is ambiguous: a NEW idempotency key for the same offer is refused", async () => {
  for (const mode of ["timeoutAfterAccept", "dns", "accept"]) {
    const w = world(mode);
    await book(w.deps, "key-1").catch(() => {});
    const calls = w.supplier.bookCalls.length;
    await assert.rejects(() => book(w.deps, "key-2"), (e) => e.code === "BOOKING_IN_PROGRESS_FOR_OFFER", mode);
    assert.equal(w.supplier.bookCalls.length, calls, mode);
  }
  // a definitive refusal frees the offer for a retry with a new key
  const w = world("reject");
  await book(w.deps, "key-1").catch(() => {});
  assert.equal(onlyBooking(w).status, "failed");
  w.supplier.mode = "accept";
  assert.equal((await book(w.deps, "key-2")).replay, false);
  assert.equal(w.supplier.created, 1);
});

test("the race backstop: if two different-key requests slip past the check, the database index stops the second", async () => {
  const w = world("accept");
  const realFind = w.Bookings.findLiveForOffer;
  w.Bookings.findLiveForOffer = async () => null;           // both requests "see" no live booking
  const [a, b] = await Promise.allSettled([book(w.deps, "ka"), book(w.deps, "kb")]);
  w.Bookings.findLiveForOffer = realFind;
  assert.equal([a, b].filter((r) => r.status === "fulfilled").length, 1);
  const lost = [a, b].find((r) => r.status === "rejected");
  assert.equal(lost.reason.code, "BOOKING_IN_PROGRESS_FOR_OFFER");
  assert.equal(w.supplier.created, 1);
});

test("R05: duplicate frontend requests -> one booking intent, one supplier booking", async () => {
  const w = world("accept");
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => book(w.deps, "same-key")));
  assert.equal(w.supplier.created, 1);
  assert.equal(w.Bookings.rows.size, 1);
  assert.equal(results.filter((r) => !r.replay).length, 1);
  assert.equal(results.filter((r) => r.replay).length, 4);
  await assert.rejects(() => book(w.deps, "same-key", { ...BODY, passengers: [{ firstName: "DIFFERENT" }] }), (e) => e.code === "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY");
  assert.equal(w.supplier.created, 1);
  await assert.rejects(() => book(w.deps, "another-key"), (e) => e.code === "BOOKING_IN_PROGRESS_FOR_OFFER"); // same offer, new key: refused
  const other = bookingDeps({ Bookings: w.Bookings, supplier: w.supplier, offer: { id: "off2", supplier_code: "x", supplier_offer_ref: "so2", expires_at: new Date(Date.now() + 3600e3), payload: {} } });
  await book(other, "another-key", { ...BODY, offerId: "off2" });
  assert.equal(w.supplier.created, 2);                     // a genuinely different offer is a new booking
});

// ---------------------------------------------------------------------------------------------------------- R06
test("R06: a poller crash mid-step is safe: nothing concluded, re-run completes exactly once", async () => {
  const w = world("accept");
  await book(w.deps);
  const id = onlyBooking(w).id;
  w.supplier.live = { state: "confirmed", pnr: "PNR9" };
  w.Bookings.failNext("transition");                       // the worker dies while writing the result
  const crashed = await pollOne(w.Bookings.get(id), { Bookings: w.Bookings, getSupplier: () => w.supplier, now: () => 0 });
  assert.equal(crashed.action, "poll_failed");
  assert.equal(w.Bookings.get(id).status, "processing");
  const again = await pollOne(w.Bookings.get(id), { Bookings: w.Bookings, getSupplier: () => w.supplier, now: () => 0 });
  assert.equal(again.action, "resolved_confirmed");
  assert.equal(w.Bookings.get(id).history.filter((h) => h === "confirmed").length, 1);
  const third = await pollOne(w.Bookings.get(id), { Bookings: w.Bookings, getSupplier: () => w.supplier, now: () => 0 });
  assert.notEqual(third.action, "advanced");               // terminal: no further state change
  assert.equal(w.Bookings.get(id).history.filter((h) => h === "confirmed").length, 1);
});

test("R06: an outbox consumer crash re-delivers later and is delivered exactly once in the end", async () => {
  const log = { delivered: [], retry: [] };
  const Outbox = { markDelivered: async (id) => log.delivered.push(id), scheduleRetry: async (id, ms) => log.retry.push([id, ms]), markDead: async () => {} };
  let crashes = 1;
  const handlers = { "booking.confirmed": async () => { if (crashes-- > 0) throw new Error("worker killed"); } };
  const row = { id: "e1", event_type: "booking.confirmed", attempts: 1 };
  await dispatchBatch([row], { Outbox, handlers });
  assert.deepEqual(log.delivered, []);
  assert.equal(log.retry.length, 1);
  await dispatchBatch([{ ...row, attempts: 2 }], { Outbox, handlers });
  assert.deepEqual(log.delivered, ["e1"]);
});

// ---------------------------------------------------------------------------------------- R07 / R08 / R14 (money)
const CAPS = { partialCapture: true, partialRefund: true, void: true };
const payOf = (w, over = {}) => ({ id: "p1", status: w.payment.status, currency: "NGN", totalMinor: 100000, authorizedMinor: 100000, capturedMinor: w.payment.captured_minor, refundedMinor: w.payment.refunded_minor, ...over });

test("R07: payment authorised, booking fails -> authorisation released, nothing captured", async () => {
  const w = paymentWorld();
  const d = decideSettlement(payOf(w), [{ id: "b1", status: "failed", amountMinor: 100000 }], CAPS);
  assert.deepEqual(d.actions.map((a) => a.type), ["void"]);
  await runSettlement(d, w);
  assert.equal(w.payment.status, "voided");
  assert.equal(w.payment.captured_minor, 0);
  assert.equal(w.Ledger.entries.filter((e) => e.kind === "capture").length, 0);
  // provider cannot void -> a human is told, nothing is guessed
  assert.equal(decideSettlement(payOf(paymentWorld()), [{ id: "b1", status: "failed", amountMinor: 100000 }], { ...CAPS, void: false }).escalate.code, "VOID_UNSUPPORTED");
});

test("R08: booking succeeds, capture fails -> the booking is preserved and the failure is escalated", async () => {
  const w = paymentWorld();
  const Bookings = makeBookings(); const supplier = makeSupplier({ mode: "accept" });
  await book(bookingDeps({ Bookings, supplier }));
  const id = [...Bookings.rows.keys()][0];
  supplier.live = { state: "confirmed", pnr: "P1" };
  await syncBooking(Bookings.get(id), { Bookings, getSupplier: () => supplier });
  w.provider.injectFault("capture", { definitive: true, message: "issuer declined" });
  const d = decideSettlement(payOf(w), [{ id, status: Bookings.get(id).status, amountMinor: 100000 }], CAPS);
  const res = await runSettlement(d, w);
  assert.equal(res[0].result, "failed");
  assert.equal(w.payment.status, "capture_failed");
  assert.equal(Bookings.get(id).status, "confirmed");      // settlement never un-confirms a booking
});

test("R14: refund request times out -> in doubt, retried with the same key, refunded once, never above the balance", async () => {
  const w = paymentWorld({ status: "captured", captured_minor: 100000 });
  const d = decideSettlement(payOf(w), [{ id: "a", status: "confirmed", amountMinor: 60000 }, { id: "b", status: "failed", amountMinor: 40000 }], CAPS);
  w.provider.injectFault("refund", { definitive: false, times: 1, message: "ETIMEDOUT" });
  assert.equal((await runSettlement(d, w))[0].result, "in_doubt");
  assert.equal(w.payment.refunded_minor, 0);
  await runSettlement(d, w); await runSettlement(d, w);
  assert.equal(w.payment.refunded_minor, 40000);
  assert.equal(decideSettlement(payOf(w), [{ id: "a", status: "confirmed", amountMinor: 60000 }, { id: "b", status: "failed", amountMinor: 40000 }], CAPS).state, "settled");
});

// ------------------------------------------------------------------------------------------------ R09 / R10 / R12
const NOW = new Date("2026-11-18T12:00:00Z");
const approvalRow = (over = {}) => ({ id: "ap1", offer_id: "off1", approved_price: 500, currency: "USD", tolerance_pct: 1, status: "active", expires_at: new Date(NOW.getTime() + 600_000), consumed_booking_id: null, ...over });
function approvalWorld({ row = approvalRow(), validate = async () => ({ valid: true, price: 500, currency: "USD" }) } = {}) {
  const calls = { consume: 0, book: [] };
  return { calls, deps: { now: () => NOW,
    approvals: { get: async () => row, consume: async () => { calls.consume++; return { ...row, status: "consumed" }; }, attachBooking: async () => {} },
    tapi: { validateFlightOffer: validate, bookFlight: async (body, key) => { calls.book.push({ body, key }); return { bookingId: "bk1" }; } } } };
}
const approve = (w, bookingBody = {}) => executeApprovedBooking({ agencyId: "ag1", approvalId: "ap1", kind: "flight", bookingBody }, w.deps);

test("R09: offer expires before approval is used -> revalidation refuses, approval is NOT spent, nothing booked", async () => {
  const w = approvalWorld({ validate: async () => { const e = new Error("expired"); e.code = "OFFER_EXPIRED"; throw e; } });
  assert.deepEqual(await approve(w), { ok: false, reason: "OFFER_EXPIRED" });
  assert.equal(w.calls.consume, 0); assert.equal(w.calls.book.length, 0);
  const expired = approvalWorld({ row: approvalRow({ expires_at: new Date(NOW.getTime() - 1) }) });
  assert.equal((await approve(expired)).reason, "APPROVAL_EXPIRED");
  assert.equal(expired.calls.book.length, 0);
  const noLongerValid = approvalWorld({ validate: async () => ({ valid: false }) });
  assert.equal((await approve(noLongerValid)).reason, "OFFER_NO_LONGER_VALID");
  // and the booking flow itself refuses an expired offer before any side effect
  const w2 = world("accept"); w2.deps.Offers = { get: async () => ({ id: "off1", supplier_code: "x", expires_at: new Date(Date.now() - 1000) }) };
  await assert.rejects(() => book(w2.deps), (e) => e.code === "OFFER_EXPIRED");
  assert.equal(w2.Bookings.rows.size, 0);
});

test("R10: price changes during approval -> new consent required; an approval is never reused for a changed amount", async () => {
  const up = approvalWorld({ validate: async () => ({ valid: true, price: 520, currency: "USD" }) });   // +4% > 1% tolerance
  const r = await approve(up);
  assert.equal(r.reason, "PRICE_INCREASED");
  assert.equal(up.calls.consume, 0); assert.equal(up.calls.book.length, 0);
  assert.equal((await approve(approvalWorld({ validate: async () => ({ valid: true, price: 504, currency: "USD" }) }))).ok, true); // within tolerance
  assert.equal((await approve(approvalWorld({ validate: async () => ({ valid: true, price: 500, currency: "EUR" }) }))).reason, "CURRENCY_CHANGED");
  assert.equal((await approve(approvalWorld({ validate: async () => ({ valid: true, offerId: "other", price: 500, currency: "USD" }) }))).reason, "OFFER_MISMATCH");
  const spent = approvalWorld({ row: approvalRow({ status: "consumed", consumed_booking_id: "bk-old" }) });
  assert.equal((await approve(spent)).ok, false);
  assert.equal(spent.calls.book.length, 0);
});

test("R12: prompt injection cannot spend money: no approval, a cancelled approval, or a swapped offer all fail closed", async () => {
  const none = approvalWorld(); none.deps.approvals.get = async () => null;
  assert.equal((await approve(none)).reason, "NO_APPROVAL");
  assert.equal(none.calls.book.length, 0);
  assert.equal((await approve(approvalWorld({ row: approvalRow({ status: "cancelled" }) }))).reason, "APPROVAL_CANCELLED");
  const swap = approvalWorld();
  await approve(swap, { offerId: "attacker-chosen-offer", amount: 1 });
  assert.equal(swap.calls.book[0].body.offerId, "off1");   // the approved offer always wins
  const tools = SRC("src/agent/tools.js");
  const names = [...tools.matchAll(/name:\s*"([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(names.length >= 4);
  assert.ok(!names.some((n) => /book|pay|charge|capture|refund|passport/.test(n)), `agent tools must not include spending or passport tools: ${names}`);
});

// ---------------------------------------------------------------------------------------------------------- R11
test("R11: the model can never see passport data; a leak is caught", () => {
  const traveller = { id: "t1", firstName: "Ada", passportNumber: "A12345678", passportExpiry: "2031-01-01", dateOfBirth: "1990-02-03", email: "ada@x.com", phone: "+2348000", homeAirport: "LOS", preferences: { cabinClass: "economy", passportNumber: "A12345678" }, loyaltyPrograms: [{ program: "BA", accountNumber: "999111" }] };
  const view = toModelView(traveller);
  assert.doesNotThrow(() => assertNoSecrets(view, ["A12345678", "2031-01-01", "1990-02-03", "ada@x.com", "+2348000", "999111"]));
  assert.throws(() => assertNoSecrets({ note: "passport A12345678" }, ["A12345678"]), /PII leak/);
});

// ---------------------------------------------------------------------------------------------------------- R13
test("R13: supplier needs_attention (or 'completed' without evidence) never produces a confirmation", async () => {
  const b = { status: "processing", supplier_booking_id: "s1" };
  assert.equal(decideTransition(b, { state: "needs_attention", pnr: "LOOKS-REAL" }).to, "reconciliation_required"); // even with a PNR present
  assert.equal(decideTransition(b, { state: "confirmed", pnr: null }).to, "reconciliation_required");
  const w = world("accept"); await book(w.deps);
  const id = onlyBooking(w).id;
  w.supplier.live = { state: "needs_attention", manualBooking: true };
  await syncBooking(w.Bookings.get(id), { Bookings: w.Bookings, getSupplier: () => w.supplier });
  assert.equal(w.Bookings.get(id).status, "reconciliation_required");
  assert.ok(!w.Bookings.get(id).history.includes("confirmed"));
  await assert.rejects(() => w.Bookings.transition(id, "confirmed"), /without a supplier confirmation reference|Invalid/); // and the repository guard backs it up
});

// ---------------------------------------------------------------------------------------------------------- R15
test("R15 (logic level): 1,000 pending bookings are polled sequentially with bounded supplier concurrency", async () => {
  const Bookings = makeBookings();
  const supplier = makeSupplier();
  const bookings = Array.from({ length: 1000 }, (_, i) => ({ id: `p${i}`, supplier_code: "x", supplier_booking_id: `s${i}`, status: "processing", poll_attempts: 0 }));
  for (const b of bookings) Bookings.rows.set(b.id, { ...b, history: ["processing"] });
  for (const b of bookings) await pollOne(b, { Bookings, getSupplier: () => supplier, now: () => 0 }); // the worker's loop shape
  assert.equal(supplier.maxInFlight, 1);
  const poller = SRC("src/scripts/pollBookings.js");
  assert.match(poller, /BOOKING_POLL_BATCH\) \|\| 50/);        // bounded batch per pass
  assert.doesNotMatch(poller, /Promise\.all/);                 // no unbounded fan-out to the supplier
});

// ---------------------------------------------------------------------------------------------------------- R16
test("R16: Redis is not on any financial or booking path (jobs, ledger, outbox, state live in Postgres)", () => {
  const financial = ["src/services/bookingSync.js", "src/services/submissionRecovery.js", "src/services/outboxDispatcher.js", "src/services/settlementExecutor.js",
    "src/services/settlementService.js", "src/services/flightBookingExecutor.js", "src/domain/settlement.js", "src/domain/outbox.js", "src/domain/liveBookingState.js",
    "src/scripts/pollBookings.js", "src/scripts/dispatchOutbox.js", "src/scripts/settleSweep.js", "src/repositories/index.js"];
  for (const f of financial) assert.doesNotMatch(SRC(f), /redis|rateLimitStore|tokenBucket/i, f);
});
