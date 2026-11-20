// Dependency-free unit tests (node:test) for the agent's pure logic and the
// booking executor with injected fakes. Run: npm run test:unit
// These do NOT touch Postgres or any supplier.
const test = require("node:test");
const assert = require("node:assert/strict");
const { assertValidTripTransition, mapBookingStatusToItemStatus, deriveTripState, pathForward, InvalidTripTransitionError, TRIP_TRANSITIONS } = require("../../src/domain/tripStateMachine");
const { STATES } = require("../../src/domain/bookingStateMachine");
const { buildApproval, checkApproval, fromRow } = require("../../src/domain/approval");
const { labelPrice } = require("../../src/domain/priceProvenance");
const { toModelView, assertNoSecrets } = require("../../src/agent/piiBoundary");
const { executeApprovedBooking, approvalIdempotencyKey } = require("../../src/agent/bookingExecutor");
const { createTapiClient } = require("../../src/agent/tapiClient");

const NOW = new Date("2026-11-13T10:00:00Z");
const mkApproval = (over = {}) => ({ id: "ap1", offer_id: "off1", approved_price: 500, currency: "USD", tolerance_pct: 0, status: "active", expires_at: new Date(NOW.getTime() + 600_000), ...over });

test("trip transitions: legal ok, illegal rejected, terminal states stay terminal", () => {
  assertValidTripTransition("draft", "researching");
  assert.throws(() => assertValidTripTransition("draft", "booked"), InvalidTripTransitionError);
  assert.throws(() => assertValidTripTransition("cancelled", "draft"), InvalidTripTransitionError);
  assert.throws(() => assertValidTripTransition("awaiting_approval", "booked"), InvalidTripTransitionError); // must pass through booking
});

test("every TAPI booking state maps to an item status; unknown fails closed", () => {
  for (const s of STATES) assert.ok(mapBookingStatusToItemStatus(s), s);
  assert.equal(mapBookingStatusToItemStatus("something_new"), "reconciliation_required");
  assert.notEqual(mapBookingStatusToItemStatus("reconciliation_required"), "confirmed");
  assert.equal(mapBookingStatusToItemStatus("price_changed"), "selected");
});

test("deriveTripState", () => {
  const it = (status) => ({ status });
  assert.equal(deriveTripState([it("confirmed"), it("confirmed")]), "booked");
  assert.equal(deriveTripState([it("confirmed"), it("booking")]), "booking");
  assert.equal(deriveTripState([it("confirmed"), it("selected")]), "partially_booked");
  assert.equal(deriveTripState([it("confirmed"), it("failed")]), "needs_attention");
  assert.equal(deriveTripState([it("confirmed"), it("cancelled")]), "booked");
  assert.equal(deriveTripState([it("selected")]), null);
  assert.equal(deriveTripState([]), null);
});

test("checkApproval blocks: none, used, expired, invalid offer, mismatch, currency, price increase", () => {
  const live = { offerId: "off1", price: 500, currency: "USD", valid: true };
  const A = (o) => fromRow(mkApproval(o));
  assert.equal(checkApproval(A(), live, NOW).ok, true);
  assert.equal(checkApproval(null, live, NOW).reason, "NO_APPROVAL");
  assert.equal(checkApproval(A({ status: "consumed" }), live, NOW).reason, "APPROVAL_CONSUMED");
  assert.equal(checkApproval(A({ expires_at: new Date(NOW.getTime() - 1) }), live, NOW).reason, "APPROVAL_EXPIRED");
  assert.equal(checkApproval(A(), { ...live, valid: false }, NOW).reason, "OFFER_NO_LONGER_VALID");
  assert.equal(checkApproval(A(), { ...live, offerId: "other" }, NOW).reason, "OFFER_MISMATCH");
  assert.equal(checkApproval(A(), { ...live, currency: "EUR" }, NOW).reason, "CURRENCY_CHANGED");
  assert.equal(checkApproval(A(), { ...live, price: 500.01 }, NOW).reason, "PRICE_INCREASED");
  assert.equal(checkApproval(A(), { ...live, price: 450 }, NOW).ok, true); // cheaper is fine
});

test("price tolerance is an explicit ceiling", () => {
  const A = (o) => fromRow(mkApproval(o));
  const live = { offerId: "off1", price: 505, currency: "USD", valid: true };
  assert.equal(checkApproval(A({ tolerance_pct: 1 }), live, NOW).ok, true);
  assert.equal(checkApproval(A({ tolerance_pct: 0.5 }), live, NOW).ok, false);
  assert.throws(() => buildApproval({ offerId: "o", price: 10, currency: "USD", toleranceBps: 5000 }));
  assert.throws(() => buildApproval({ offerId: "o", price: 0, currency: "USD" }));
});

test("price labels never claim 'confirmed' for mock or stale data", () => {
  assert.equal(labelPrice({ source: "mock", validatedAt: NOW, now: NOW }), "unverified");
  assert.equal(labelPrice({ source: "tapi", validatedAt: new Date(NOW - 60_000), now: NOW }), "confirmed");
  assert.equal(labelPrice({ source: "tapi", retrievedAt: new Date(NOW - 60_000), now: NOW }), "estimated");
  assert.equal(labelPrice({ source: "tapi", retrievedAt: new Date(NOW - 3_600_000), now: NOW }), "unverified");
  assert.equal(labelPrice({ source: "model", validatedAt: NOW, now: NOW }), "unverified");
});

test("model view is an allowlist: passport, DOB, phone, email, loyalty numbers never appear", () => {
  const traveller = { id: "t1", firstName: "Ada", lastName: "Obi", passportNumber: "A12345678", dateOfBirth: "1990-01-02", phone: "+2348012345678", email: "ada@example.com", homeAirport: "ABV",
    preferences: { cabinClass: "economy", hotelTier: "4-star", secretNote: "x" }, loyaltyPrograms: [{ program: "BA", accountNumber: "99887766" }] };
  const view = toModelView(traveller);
  assert.deepEqual(view.loyaltyPrograms, ["BA"]);
  assert.equal(view.preferences.secretNote, undefined);
  assertNoSecrets(view, ["A12345678", "1990-01-02", "+2348012345678", "ada@example.com", "99887766", "Obi"]);
  assert.throws(() => assertNoSecrets({ x: "A12345678" }, ["A12345678"]));
});

function fakeDeps({ approval, verdict, consumeResult = "ok", validateError } = {}) {
  const calls = { validate: 0, consume: 0, book: [], attach: [] };
  const state = { approval };
  return { calls, deps: {
    now: () => NOW,
    approvals: {
      get: async () => state.approval,
      consume: async () => { calls.consume++; if (consumeResult !== "ok") return null; state.approval = { ...state.approval, status: "consumed" }; return state.approval; },
      attachBooking: async (id, a, b) => { calls.attach.push(b); state.approval = { ...state.approval, consumed_booking_id: b }; },
    },
    tapi: {
      validateFlightOffer: async () => { calls.validate++; if (validateError) throw validateError; return verdict; },
      validateHotelOffer: async () => { calls.validate++; return verdict; },
      bookFlight: async (body, key) => { calls.book.push({ body, key }); return { bookingId: "bk1", status: "pending" }; },
      bookHotel: async (body, key) => { calls.book.push({ body, key }); return { bookingId: "bk2", status: "pending" }; },
    } } };
}
const run = (deps) => executeApprovedBooking({ agencyId: "ag1", approvalId: "ap1", kind: "flight", bookingBody: { passengers: [], contact: {} } }, deps);
const goodVerdict = { offerId: "off1", valid: true, offer: { price: 500, currency: "USD" } };

test("executor: happy path validates, consumes once, books with approval-derived idempotency key", async () => {
  const { calls, deps } = fakeDeps({ approval: mkApproval(), verdict: goodVerdict });
  const r = await run(deps);
  assert.equal(r.ok, true);
  assert.equal(calls.consume, 1);
  assert.equal(calls.book.length, 1);
  assert.equal(calls.book[0].key, approvalIdempotencyKey("ap1"));
  assert.deepEqual(calls.attach, ["bk1"]);
});

test("executor: no approval, expired, price increase, TAPI PRICE_CHANGED -> no consume, no booking", async () => {
  const cases = [
    [fakeDeps({ approval: null, verdict: goodVerdict }), "NO_APPROVAL"],
    [fakeDeps({ approval: mkApproval({ expires_at: new Date(NOW - 1) }), verdict: goodVerdict }), "APPROVAL_EXPIRED"],
    [fakeDeps({ approval: mkApproval(), verdict: { ...goodVerdict, offer: { price: 600, currency: "USD" } } }), "PRICE_INCREASED"],
    [fakeDeps({ approval: mkApproval(), validateError: Object.assign(new Error("x"), { code: "PRICE_CHANGED" }) }), "PRICE_CHANGED"],
    [fakeDeps({ approval: mkApproval(), validateError: Object.assign(new Error("x"), { code: "OFFER_EXPIRED" }) }), "OFFER_EXPIRED"],
  ];
  for (const [{ calls, deps }, reason] of cases) {
    const r = await run(deps);
    assert.equal(r.ok, false); assert.equal(r.reason, reason);
    assert.equal(calls.consume, 0); assert.equal(calls.book.length, 0);
  }
});

test("executor: unknown validate failure propagates and does not consume the approval", async () => {
  const { calls, deps } = fakeDeps({ approval: mkApproval(), validateError: Object.assign(new Error("boom"), { code: "INTERNAL_ERROR" }) });
  await assert.rejects(run(deps), /boom/);
  assert.equal(calls.consume, 0); assert.equal(calls.book.length, 0);
});

test("executor: losing the consume race books nothing", async () => {
  const { calls, deps } = fakeDeps({ approval: mkApproval(), verdict: goodVerdict, consumeResult: "lost" });
  const r = await run(deps);
  assert.equal(r.reason, "APPROVAL_ALREADY_USED_OR_EXPIRED");
  assert.equal(calls.book.length, 0);
});

test("executor: consumed approval with no booking id retries with the SAME key and skips revalidation", async () => {
  const { calls, deps } = fakeDeps({ approval: mkApproval({ status: "consumed", consumed_at: new Date(NOW.getTime() - 60_000) }), verdict: goodVerdict });
  const r = await run(deps);
  assert.equal(r.ok, true);
  assert.equal(calls.validate, 0); assert.equal(calls.consume, 0);
  assert.equal(calls.book[0].key, approvalIdempotencyKey("ap1"));
});

test("executor: consumed approval that already has a booking cannot be reused", async () => {
  const { calls, deps } = fakeDeps({ approval: mkApproval({ status: "consumed", consumed_booking_id: "bk1" }), verdict: goodVerdict });
  const r = await run(deps);
  assert.equal(r.ok, false);
  assert.equal(calls.book.length, 0);
});

test("tapi client: sends bearer + idempotency key, polls until done, surfaces TAPI error codes", async () => {
  const seen = [];
  let n = 0;
  const fetchImpl = async (url, opts) => {
    seen.push({ url, opts });
    const json = async () => {
      if (url.endsWith("/v1/flights/search")) return { searchId: "s1" };
      if (url.endsWith("/v1/flights/search/s1")) return ++n < 3 ? { status: "processing" } : { status: "completed", offers: [{ offerId: "o1" }] };
      if (url.endsWith("/v1/flights/bookings")) return { code: "PRICE_CHANGED", detail: "changed" };
      return {};
    };
    return { ok: !url.endsWith("/v1/flights/bookings"), status: url.endsWith("/v1/flights/bookings") ? 409 : 200, json };
  };
  const c = createTapiClient({ baseUrl: "http://t", apiKey: "k", fetchImpl, sleep: async () => {} });
  const res = await c.searchFlights({ origin: "ABV", destination: "LHR", departDate: "2026-12-10" });
  assert.equal(res.offers[0].offerId, "o1");
  assert.equal(seen[0].opts.headers.Authorization, "Bearer k");
  await assert.rejects(c.bookFlight({ offerId: "o1" }, "key-1"), (e) => e.code === "PRICE_CHANGED" && e.status === 409);
  assert.equal(seen.at(-1).opts.headers["Idempotency-Key"], "key-1");
  assert.throws(() => createTapiClient({ baseUrl: "http://t" }), /apiKey/);
});

test("executor: a caller-supplied offerId in the booking body cannot override the approved offer", async () => {
  const { calls, deps } = fakeDeps({ approval: mkApproval(), verdict: goodVerdict });
  await executeApprovedBooking({ agencyId: "ag1", approvalId: "ap1", kind: "flight", bookingBody: { offerId: "EVIL", passengers: [] } }, deps);
  assert.equal(calls.book[0].body.offerId, "off1");
});

test("trip progression: forward-only through legal hops, never out of terminal or booked states", () => {
  assert.deepEqual(pathForward("draft", "researching"), ["researching"]);
  assert.deepEqual(pathForward("draft", "awaiting_approval"), ["researching", "itinerary_ready", "awaiting_approval"]);
  assert.deepEqual(pathForward("itinerary_ready", "booking"), ["awaiting_approval", "booking"]);
  for (const [from, to] of [["booking", "researching"], ["researching", "researching"], ["booked", "booking"], ["cancelled", "researching"], ["needs_attention", "booking"], ["draft", "nonsense"]]) {
    assert.deepEqual(pathForward(from, to), [], `${from} -> ${to}`);
  }
  // every hop it can ever produce is an allowed transition
  for (const from of ["draft", "researching", "itinerary_ready", "awaiting_approval"]) {
    let cur = from;
    for (const next of pathForward(from, "booking")) { assert.ok(TRIP_TRANSITIONS[cur].includes(next), `${cur} -> ${next}`); cur = next; }
  }
});

test("executor reports the revalidated live price on a fresh booking, and none on the retry path", async () => {
  let f = fakeDeps({ approval: mkApproval(), verdict: { offerId: "off1", valid: true, offer: { price: 480, currency: "USD" } } });
  assert.equal((await run(f.deps)).livePrice, 480);
  f = fakeDeps({ approval: mkApproval({ status: "consumed", consumed_at: new Date(NOW.getTime() - 60_000) }), verdict: goodVerdict });
  assert.equal((await run(f.deps)).livePrice, undefined);
});
