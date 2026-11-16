const test = require("node:test");
const assert = require("node:assert/strict");
const F = require("../../src/domain/fulfilment");
const { fromRow } = require("../../src/domain/approval");
const { deriveTripState, regressTarget, assertValidTripTransition } = require("../../src/domain/tripStateMachine");
const { travellerMayCall } = require("../../src/domain/access");

const NOW = new Date("2026-11-14T10:00:00Z");
const approval = (o = {}) => fromRow({ id: "ap1", offer_id: "off1", approved_price: 500, currency: "USD", tolerance_pct: 0, status: "active", expires_at: new Date(NOW.getTime() + 3600_000), ...o });

test("approval lifetime: 30 minutes for automated, 48 hours for agent-assisted, overridable within sane bounds", () => {
  assert.equal(F.approvalTtlMinutes("automated"), 30);
  assert.equal(F.approvalTtlMinutes("agent_assisted", {}), 48 * 60);
  assert.equal(F.approvalTtlMinutes("agent_assisted", { AGENT_APPROVAL_TTL_HOURS: "6" }), 360);
  for (const bad of ["0", "-3", "abc", "9999"]) assert.equal(F.approvalTtlMinutes("agent_assisted", { AGENT_APPROVAL_TTL_HOURS: bad }), 48 * 60, bad);
});

test("mode resolution: default automated; agent always available; self-booking off forces the agent route", () => {
  const trav = { role: "traveller" }, agent = { role: "agent" };
  assert.deepEqual(F.resolveMode({ principal: trav }), { mode: "automated", forced: false });
  assert.deepEqual(F.resolveMode({ principal: trav, requested: "agent_assisted" }), { mode: "agent_assisted", forced: false });
  assert.deepEqual(F.resolveMode({ principal: trav, agencySelfBooking: false }), { mode: "agent_assisted", forced: true });
  assert.deepEqual(F.resolveMode({ principal: trav, agencySelfBooking: false, requested: "agent_assisted" }), { mode: "agent_assisted", forced: true });
  assert.equal(F.resolveMode({ principal: trav, agencySelfBooking: false, requested: "automated" }).error, "SELF_BOOKING_DISABLED");
  assert.deepEqual(F.resolveMode({ principal: agent, agencySelfBooking: false }), { mode: "automated", forced: false });   // the policy binds travellers, not staff
  assert.equal(F.resolveMode({ principal: trav, requested: "robot" }).error, "INVALID_MODE");
});

test("claiming: staff of the same agency, open requests only", () => {
  const r = { agency_id: "a1", status: "open" };
  assert.equal(F.canClaim({ role: "agent", agencyId: "a1" }, r).ok, true);
  assert.equal(F.canClaim({ role: "traveller", agencyId: "a1" }, r).reason, "FORBIDDEN");
  assert.equal(F.canClaim({ role: "agent", agencyId: "a2" }, r).reason, "NOT_FOUND");
  assert.equal(F.canClaim({ role: "agent", agencyId: "a1" }, { ...r, status: "claimed" }).reason, "NOT_OPEN");
});

test("working a request: only the claimer, an admin or an API key; never an unclaimed or someone else's request", () => {
  const r = { agency_id: "a1", status: "claimed", claimed_by_user_id: "u1" };
  assert.equal(F.canWork({ type: "session", role: "agent", agencyId: "a1", userId: "u1" }, r).ok, true);
  assert.equal(F.canWork({ type: "session", role: "agent", agencyId: "a1", userId: "u2" }, r).reason, "CLAIMED_BY_SOMEONE_ELSE");
  assert.equal(F.canWork({ type: "session", role: "admin", agencyId: "a1", userId: "u2" }, r).ok, true);
  assert.equal(F.canWork({ type: "api_key", role: "admin", agencyId: "a1" }, r).ok, true);
  assert.equal(F.canWork({ type: "session", role: "agent", agencyId: "a1", userId: "u1" }, { ...r, status: "open" }).reason, "NOT_CLAIMED");
  assert.equal(F.canWork({ type: "session", role: "agent", agencyId: "a2", userId: "u1" }, r).reason, "NOT_FOUND");
});

test("completion cannot exceed the approved price, change currency, or use an expired/used approval", () => {
  const ok = (p, c = "USD", a = approval()) => F.checkCompletion(a, { finalPrice: p, currency: c }, NOW);
  assert.equal(ok(500).ok, true); assert.equal(ok(430.5).ok, true);
  assert.equal(ok(500.01).reason, "PRICE_INCREASED");
  assert.equal(ok(500, "EUR").reason, "CURRENCY_CHANGED");
  assert.equal(ok(500, "USD", approval({ expires_at: new Date(NOW - 1) })).reason, "APPROVAL_EXPIRED");
  assert.equal(ok(500, "USD", approval({ status: "consumed" })).reason, "APPROVAL_CONSUMED");
  assert.equal(ok(500, "USD", approval({ status: "revoked" })).reason, "APPROVAL_REVOKED");
  assert.equal(ok(500, "USD", null).reason, "NO_APPROVAL");
  assert.equal(F.checkCompletion(approval({ tolerance_pct: 1 }), { finalPrice: 505, currency: "USD" }, NOW).ok, true);
});

test("input validation: completion, decline reason, reprice, traveller note", () => {
  assert.deepEqual(F.validateCompletion({ confirmationRef: " ABC123 ", finalPrice: "480.456", currency: "USD", note: " done " }).value, { confirmationRef: "ABC123", finalPrice: 480.46, currency: "USD", note: "done" });
  for (const bad of [{}, { confirmationRef: "", finalPrice: 1, currency: "USD" }, { confirmationRef: "x\ny", finalPrice: 1, currency: "USD" }, { confirmationRef: "A", finalPrice: 0, currency: "USD" },
    { confirmationRef: "A", finalPrice: -5, currency: "USD" }, { confirmationRef: "A", finalPrice: 1, currency: "usd" }, { confirmationRef: "A".repeat(81), finalPrice: 1, currency: "USD" }, { confirmationRef: "A", finalPrice: 1e9, currency: "USD" }]) {
    assert.ok(F.validateCompletion(bad).error, JSON.stringify(bad));
  }
  assert.ok(F.validateReason({ reason: "no" }).error); assert.equal(F.validateReason({ reason: "Sold out" }).value, "Sold out");
  assert.ok(F.validateReprice({ newPrice: 0, note: "price rose" }).error); assert.ok(F.validateReprice({ newPrice: 600, note: "" }).error);
  assert.deepEqual(F.validateReprice({ newPrice: "612.5", note: "Fare class sold out" }).value, { newPrice: 612.5, note: "Fare class sold out" });
  assert.equal(F.validateTravellerNote("x".repeat(501)).error !== undefined, true); assert.equal(F.validateTravellerNote(undefined).value, null);
});

test("an item waiting for or being worked by an agent counts as booking in progress for the trip", () => {
  const it = (status) => ({ status });
  assert.equal(deriveTripState([it("agent_requested")]), "booking");
  assert.equal(deriveTripState([it("agent_working"), it("confirmed")]), "booking");
  assert.equal(deriveTripState([it("confirmed"), it("selected")]), "partially_booked");
  assert.equal(deriveTripState([it("agent_requested"), it("failed")]), "needs_attention");
});

test("travellers cannot reach the agent queue", () => {
  for (const [m, p] of [["GET", "/v1/fulfilment"], ["POST", "/v1/fulfilment/abc/claim"], ["POST", "/v1/fulfilment/abc/complete"], ["POST", "/v1/fulfilment/abc/reveal"]]) assert.equal(travellerMayCall(m, p), false, `${m} ${p}`);
  assert.equal(travellerMayCall("POST", "/v1/trips/abc/items/def/cancel-request"), true);        // they may withdraw their own request
});

test("a trip steps back out of 'booking' when nothing is in progress any more, but never while something is", () => {
  const it = (status) => ({ status });
  assert.equal(regressTarget("booking", [it("selected"), it("proposed")]), "itinerary_ready");     // request withdrawn / sent back for a new price
  assert.equal(regressTarget("booking", [it("agent_requested"), it("selected")]), null);
  assert.equal(regressTarget("booking", [it("confirmed"), it("selected")]), null);
  assert.equal(regressTarget("booking", [it("failed")]), null);                                    // failures go to needs_attention instead
  assert.equal(regressTarget("awaiting_approval", [it("selected")]), null);
  assert.equal(regressTarget("booked", [it("selected")]), null);
  assert.doesNotThrow(() => assertValidTripTransition("booking", "itinerary_ready"));
});
