// Sprint 10.0 — supplier abstraction, async booking sync, ticketing_pending.
// Pure unit tests: no database, no network, no supplier.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const Module = require("module");

// The registry transitively loads mockBusAdapter -> uuid; stub it so these tests
// do not depend on node_modules being installed.
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "uuid") return { v4: () => "00000000-0000-4000-8000-000000000000" };
  return origLoad.call(this, request, ...rest);
};

const { decideTransition, nextPollDelayMs } = require("../../src/domain/liveBookingState");
const { syncBooking, pollOne, classifyBookResult, supplierBookingId, MAX_POLL_ATTEMPTS } = require("../../src/services/bookingSync");
const { assertFlightSupplier, FlightSupplier, DEFAULT_CAPABILITIES } = require("../../src/services/flightSupplier.interface");
const { LetsFGAdapter, normalizeLetsFGState, encodeSandboxSnapshot, MAX_SANDBOX_SNAPSHOT_CHARS } = require("../../src/services/adapters/letsfgAdapter");
const { TiqwaAdapter } = require("../../src/services/adapters/tiqwaAdapter");
const { NigerianDomesticAdapter } = require("../../src/services/adapters/nigerianDomesticAdapter");
const { STATES, TRANSITIONS, INTERMEDIATE_STATES, assertValidTransition } = require("../../src/domain/bookingStateMachine");

// ---- fakes -----------------------------------------------------------------
function fakeBookings() {
  const calls = { transitions: [], polled: [] };
  return {
    calls,
    async transition(id, to, opts) { calls.transitions.push({ id, to, ...opts }); return { id, status: to, supplier_reference: opts.supplierReference || null }; },
    async markPolled(id, opts) { calls.polled.push({ id, ...opts }); },
  };
}
const supplierReturning = (live) => () => ({ getBooking: async () => live });
const supplierThrowing = () => () => ({ getBooking: async () => { throw new Error("EAI_AGAIN"); } });
const booking = (over = {}) => ({ id: "b1", supplier_code: "x", supplier_booking_id: "sup-1", status: "processing", poll_attempts: 0, ...over });

// ---- decision table ----------------------------------------------------------
test("confirmed requires evidence: completed + PNR confirms, completed without PNR escalates", () => {
  assert.deepEqual(decideTransition(booking(), { state: "confirmed", pnr: "ABC123" }), { to: "confirmed", supplierReference: "ABC123", reason: "supplier completed the booking with evidence reference" });
  assert.equal(decideTransition(booking(), { state: "confirmed", pnr: null }).to, "reconciliation_required");
  assert.equal(decideTransition(booking({ status: "reconciliation_required" }), { state: "confirmed", pnr: null }), null);
});

test("failed, needs_attention, ticketing_pending, in_progress and unknown states", () => {
  assert.equal(decideTransition(booking(), { state: "failed", failureReason: "declined" }).to, "failed");
  assert.equal(decideTransition(booking(), { state: "needs_attention" }).to, "reconciliation_required");
  assert.equal(decideTransition(booking({ status: "reconciliation_required" }), { state: "needs_attention" }), null);
  assert.equal(decideTransition(booking(), { state: "ticketing_pending" }).to, "ticketing_pending");
  assert.equal(decideTransition(booking({ status: "ticketing_pending" }), { state: "ticketing_pending" }), null);
  assert.equal(decideTransition(booking({ status: "pending" }), { state: "in_progress" }).to, "processing");
  assert.equal(decideTransition(booking(), { state: "in_progress" }), null);
  // silence / unfamiliar vocabulary is never success
  assert.equal(decideTransition(booking(), { state: "banana", pnr: "ZZZ" }), null);
  assert.equal(decideTransition(booking(), {}), null);
});

test("terminal and non-open bookings are never touched", () => {
  for (const status of ["confirmed", "failed", "cancelled", "refunded", "created"]) {
    assert.equal(decideTransition(booking({ status }), { state: "confirmed", pnr: "A" }), null, status);
  }
});

test("every transition the decision layer can emit is legal in the state machine", () => {
  const lives = [{ state: "confirmed", pnr: "A" }, { state: "confirmed" }, { state: "failed" }, { state: "needs_attention" }, { state: "ticketing_pending" }, { state: "in_progress" }];
  for (const status of ["pending", "processing", "ticketing_pending", "reconciliation_required"]) {
    for (const live of lives) {
      const d = decideTransition(booking({ status }), live);
      if (d) assert.doesNotThrow(() => assertValidTransition(status, d.to), `${status} -> ${d.to}`);
    }
  }
});

test("poll backoff grows and is capped at 15 minutes", () => {
  assert.equal(nextPollDelayMs(0), 15_000);
  assert.equal(nextPollDelayMs(1), 30_000);
  assert.equal(nextPollDelayMs(2), 60_000);
  assert.equal(nextPollDelayMs(50), 15 * 60_000);
});

// ---- syncBooking / pollOne --------------------------------------------------
test("syncBooking uses the supplier's own booking id, not the evidence reference", async () => {
  let asked;
  const getSupplier = () => ({ getBooking: async (ref) => { asked = ref; return { state: "in_progress" }; } });
  await syncBooking(booking({ supplier_reference: "PNR-OLD" }), { Bookings: fakeBookings(), getSupplier });
  assert.equal(asked, "sup-1");
  assert.equal(supplierBookingId({ supplier_reference: "legacy" }), "legacy");
});

test("syncBooking confirms with evidence and records the actor", async () => {
  const Bookings = fakeBookings();
  const r = await syncBooking(booking(), { Bookings, getSupplier: supplierReturning({ state: "confirmed", pnr: "XYZ" }), actor: "booking-poller" });
  assert.equal(r.changed, true);
  assert.equal(Bookings.calls.transitions[0].to, "confirmed");
  assert.equal(Bookings.calls.transitions[0].supplierReference, "XYZ");
  assert.equal(Bookings.calls.transitions[0].actor, "booking-poller");
});

test("a failed supplier call changes nothing and the poller backs off (DNS EAI_AGAIN case)", async () => {
  const Bookings = fakeBookings();
  const r = await pollOne(booking(), { Bookings, getSupplier: supplierThrowing(), now: () => 0 });
  assert.equal(r.action, "poll_failed");
  assert.equal(Bookings.calls.transitions.length, 0);
  assert.equal(Bookings.calls.polled[0].attempts, 1);
  assert.equal(Bookings.calls.polled[0].nextPollAt.getTime(), 30_000);
});

test("pollOne stops polling once terminal, and escalates after the attempt budget", async () => {
  let B = fakeBookings();
  let r = await pollOne(booking(), { Bookings: B, getSupplier: supplierReturning({ state: "confirmed", pnr: "P1" }) });
  assert.equal(r.action, "resolved_confirmed");
  assert.equal(B.calls.polled[0].nextPollAt, null);

  B = fakeBookings();
  r = await pollOne(booking({ poll_attempts: MAX_POLL_ATTEMPTS - 1 }), { Bookings: B, getSupplier: supplierReturning({ state: "in_progress" }) });
  assert.equal(r.action, "escalated");
  assert.equal(B.calls.transitions[0].to, "reconciliation_required");
});

test("classifyBookResult: async suppliers are accepted (202), never confirmed at booking time", () => {
  assert.deepEqual(classifyBookResult({ asyncBooking: true }, { supplierBookingRef: "s1" }), { asyncBooking: true, httpStatus: 202, initialStatus: "processing" });
  assert.equal(classifyBookResult({ asyncBooking: true }, {}).httpStatus, 201);
  assert.equal(classifyBookResult({ asyncBooking: false }, { supplierBookingRef: "s1" }).asyncBooking, false);
});

// ---- adapter contract ---------------------------------------------------------
test("contract: LetsFG, Tiqwa scaffold and Nigerian domestic scaffold all satisfy FlightSupplier", () => {
  const letsfg = new LetsFGAdapter({ authMode: "developer", environment: "sandbox" });
  for (const [label, a] of [["letsfg", letsfg], ["tiqwa", new TiqwaAdapter()], ["ng_domestic", new NigerianDomesticAdapter()]]) {
    assert.doesNotThrow(() => assertFlightSupplier(a, label), label);
  }
});

test("contract: violations are reported", () => {
  class Bad extends FlightSupplier { get capabilities() { return { ...DEFAULT_CAPABILITIES, supportsStop: true }; } }
  assert.throws(() => assertFlightSupplier(new Bad(), "bad"), /supportsStop=true but stop\(\) missing/);
  assert.throws(() => assertFlightSupplier({ book() {} }, "worse"), /missing method/);
});

test("Tiqwa scaffold declares reserve-then-ticket and refuses to act", async () => {
  const t = new TiqwaAdapter();
  assert.equal(t.capabilities.reserveThenTicket, true);
  assert.throws(() => t.book(), /scaffold/);
  assert.throws(() => t.search(), /not verified|not implemented/i);
});

test("LetsFG capabilities follow the environment; production has no offer validation and says so", async () => {
  const sandbox = new LetsFGAdapter({ authMode: "developer", environment: "sandbox" });
  assert.equal(sandbox.capabilities.sandbox, true);
  assert.equal(sandbox.capabilities.offerValidation, "at-booking");
  const prod = new LetsFGAdapter({ authMode: "developer", environment: "production", apiKey: "k" });
  assert.equal(prod.capabilities.sandbox, false);
  await assert.rejects(() => prod.validateOffer("o1"), (e) => e.code === "NOT_SUPPORTED" && e.status === 501);
});

test("LetsFG getBooking normalises state; only completed maps to confirmed", async () => {
  assert.equal(normalizeLetsFGState({ state: "completed" }), "confirmed");
  assert.equal(normalizeLetsFGState({ state: "failed" }), "failed");
  assert.equal(normalizeLetsFGState({ state: "needs_attention" }), "needs_attention");
  for (const s of ["authorised", "card_issued", "booking_in_progress", "awaiting_settlement", "whatever", undefined]) {
    assert.equal(normalizeLetsFGState({ state: s }), "in_progress");
  }
  const a = new LetsFGAdapter({ authMode: "developer", environment: "sandbox" });
  a.client.request = async () => ({ state: "completed", pnr: "Q1W2E3", terminal: true });
  const live = await a.getBooking("b-1");
  assert.equal(live.state, "confirmed");
  assert.equal(live.pnr, "Q1W2E3");
});

test("sandbox search snapshot is size-capped by trimming offers", () => {
  const big = Array.from({ length: 400 }, (_, i) => ({ supplierOfferRef: `o${i}`, blob: "x".repeat(2000) }));
  const encoded = encodeSandboxSnapshot(big);
  assert.ok(encoded.length <= MAX_SANDBOX_SNAPSHOT_CHARS);
  const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString());
  assert.ok(decoded.offers.length >= 1 && decoded.offers.length < 400);
  assert.equal(decoded.offers[0].supplierOfferRef, "o0");
});

// ---- registry ---------------------------------------------------------------------
test("registry: default supplier, unknown codes, and scaffold gating", () => {
  const reg = require("../../src/services/supplierRegistry");
  const prev = { ...process.env };
  try {
    delete process.env.FLIGHT_SUPPLIER_CODE; delete process.env.TIQWA_ENABLED;
    assert.equal(reg.defaultFlightSupplierCode(), "letsfg");
    process.env.FLIGHT_SUPPLIER_CODE = "nope";
    assert.throws(() => reg.defaultFlightSupplierCode(), (e) => /not a known flight supplier/.test(e.detail));
    process.env.FLIGHT_SUPPLIER_CODE = "tiqwa";
    assert.equal(reg.defaultFlightSupplierCode(), "tiqwa");
    assert.throws(() => reg.getSupplier("tiqwa"), (e) => e.code === "SUPPLIER_NOT_CONFIGURED" && /Unknown flight supplier/.test(e.detail)); // not enabled
    process.env.TIQWA_ENABLED = "true";
    const t = reg.getSupplier("tiqwa");
    assert.equal(t.capabilities.reserveThenTicket, true);
    assert.equal(reg.getSupplier("tiqwa"), t); // memoised
  } finally { process.env = prev; }
});

// ---- state machine + schema ---------------------------------------------------
test("ticketing_pending: legal edges, never directly refundable, tracked as intermediate", () => {
  assert.ok(STATES.includes("ticketing_pending"));
  assert.ok(INTERMEDIATE_STATES.includes("ticketing_pending"));
  for (const to of ["confirmed", "cancelled", "failed", "reconciliation_required"]) assert.doesNotThrow(() => assertValidTransition("ticketing_pending", to));
  for (const to of ["refund_pending", "refunded", "created"]) assert.throws(() => assertValidTransition("ticketing_pending", to));
  assert.ok(TRANSITIONS.processing.includes("ticketing_pending"));
});

test("the newest bookings_status_check in the migrations allows every state-machine state", () => {
  const dir = path.join(__dirname, "../../src/db/migrations");
  let latest = null;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    const sql = fs.readFileSync(path.join(dir, f), "utf8").replace(/--.*$/gm, "");
    const m = [...sql.matchAll(/ADD CONSTRAINT bookings_status_check\s+CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)/gi)];
    if (m.length) latest = { f, list: m[m.length - 1][1].match(/'([a-z_]+)'/g).map((x) => x.replace(/'/g, "")) };
  }
  assert.ok(latest, "found a bookings_status_check definition");
  assert.deepEqual([...latest.list].sort(), [...STATES].sort(), `check constraint in ${latest.f} must match STATES`);
});

test("migration 018 adds the columns the code relies on", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../../src/db/migrations/018_supplier_agnostic_polling.sql"), "utf8");
  for (const col of ["supplier_code", "supplier_booking_id", "poll_attempts", "last_polled_at", "next_poll_at"]) assert.match(sql, new RegExp(col));
  const repo = fs.readFileSync(path.join(__dirname, "../../src/repositories/index.js"), "utf8");
  for (const col of ["supplier_booking_id", "next_poll_at", "poll_attempts"]) assert.match(repo, new RegExp(col));
});
