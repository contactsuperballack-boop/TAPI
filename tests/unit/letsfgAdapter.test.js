const test = require("node:test");
const assert = require("node:assert/strict");
const { LetsFGAdapter, SANDBOX_RESULT_PREFIX, normalizeOffer } = require("../../src/services/adapters/letsfgAdapter");
const { LetsFGClient } = require("../../src/services/adapters/letsfgClient");

test("sandbox Developer API client accepts an omitted key but rejects PFS mode", () => {
  const client = new LetsFGClient({ authMode: "developer", environment: "sandbox" });
  assert.equal(client.environment, "sandbox");
  assert.equal(client.developerPath("flights/search"), "/developers/api/v1/sandbox/flights/search");
  assert.throws(() => new LetsFGClient({ authMode: "pfs", environment: "sandbox", bearerToken: "token" }), /requires LETSFG_AUTH_MODE=developer|sandbox requires/i);
});

test("sandbox flight search uses the documented sync endpoint and can be polled from stored ref", async () => {
  const adapter = new LetsFGAdapter({ authMode: "developer", environment: "sandbox" });
  let called;
  adapter.client.request = async (method, path, body) => {
    called = { method, path, body };
    return { search_id: "sb_search_1", source_tier: "sandbox", offers: [{ id: "sb_offer_1", airline: "Sandbox Air", price: 123, currency: "USD" }] };
  };
  const started = await adapter.search({ origin: "LOS", destination: "LHR", departDate: "2026-12-10", adults: 1, currency: "USD" });
  assert.equal(called.method, "POST");
  assert.equal(called.path, "/developers/api/v1/sandbox/flights/search");
  assert.deepEqual(called.body, { origin: "LOS", destination: "LHR", date_from: "2026-12-10", adults: 1, currency: "USD" });
  assert.ok(started.supplierSearchRef.startsWith(SANDBOX_RESULT_PREFIX));
  const result = await adapter.pollSearch(started.supplierSearchRef);
  assert.equal(result.status, "completed");
  assert.equal(result.offers[0].supplierOfferRef, "sb_offer_1");
  assert.equal(result.offers[0].supplierSearchId, "sb_search_1");
  assert.equal(result.offers[0].airline, "Sandbox Air");
});

test("production flight search uses the documented async route", async () => {
  const adapter = new LetsFGAdapter({ authMode: "developer", apiKey: "test-key", environment: "production" });
  let called;
  adapter.client.request = async (method, path, body) => { called = { method, path, body }; return { search_id: "live-search" }; };
  const result = await adapter.search({ origin: "LOS", destination: "LHR", departDate: "2026-12-10", adults: 1 });
  assert.equal(called.path, "/developers/api/v1/flights/search/async");
  assert.equal(result.supplierSearchRef, "live-search");
});

test("offer normalizer retains raw supplier payload and maps identifiers", () => {
  const raw = { id: "o1", airline: "Test Air", price: 45, currency: "EUR", stops: 0 };
  const offer = normalizeOffer(raw, "s1");
  assert.equal(offer.supplierOfferRef, "o1");
  assert.equal(offer.supplierSearchId, "s1");
  assert.equal(offer.rawSupplierOffer, raw);
  assert.equal(offer.price, 45);
});


test("sandbox booking uses the original search, idempotency key and passenger schema", async () => {
  const adapter = new LetsFGAdapter({ authMode: "developer", environment: "sandbox" });
  let called;
  adapter.client.request = async (method, path, body) => { called = { method, path, body }; return { booking_id: "sb_booking_1", state: "authorised", sandbox: true }; };
  const result = await adapter.book("sb_offer_1", [{ firstName: "Ada", lastName: "Lovelace", dateOfBirth: "1990-01-15", gender: "f", passportNumber: "P123", passportCountry: "GB", passportExpiry: "2031-05-01", passportIssueDate: "2021-05-01", nationality: "GB" }], { email: "ada@example.com" }, { supplierSearchId: "sb_search_1", idempotencyKey: "idem-1", wantSeat: true, sandboxScenario: "price_change", sandboxSpeed: "fast" });
  assert.equal(called.path, "/developers/api/v1/sandbox/flights/book");
  assert.equal(called.body.search_id, "sb_search_1");
  assert.equal(called.body.offer_id, "sb_offer_1");
  assert.equal(called.body.idempotency_key, "idem-1");
  assert.equal(called.body.sandbox.scenario, "price_change");
  assert.equal(called.body.passengers[0].passport_number, "P123");
  assert.equal(result.supplierBookingRef, "sb_booking_1");
});

test("sandbox booking poll, answer and stop use documented endpoints", async () => {
  const adapter = new LetsFGAdapter({ authMode: "developer", environment: "sandbox" });
  const calls = [];
  adapter.client.request = async (method, path, body) => { calls.push({ method, path, body }); return method === "GET" ? { state: "booking_in_progress", terminal: false, question: { kind: "seat", round: 1 }, sandbox: true } : { status: "accepted" }; };
  const poll = await adapter.getBooking("sb_booking_1");
  await adapter.answer("sb_booking_1", { round: 1, skip: true });
  await adapter.stop("sb_booking_1");
  assert.equal(poll.question.kind, "seat");
  assert.equal(calls[0].path, "/developers/api/v1/sandbox/flights/bookings/sb_booking_1");
  assert.equal(calls[1].path, "/developers/api/v1/sandbox/flights/bookings/sb_booking_1/answer");
  assert.deepEqual(calls[1].body, { round: 1, skip: true });
  assert.equal(calls[2].path, "/developers/api/v1/sandbox/flights/bookings/sb_booking_1/stop");
});
