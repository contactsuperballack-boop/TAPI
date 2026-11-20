// In-memory booking world for failure-scenario tests: a fake repository that enforces the REAL state machine and the
// idempotent-insert rule, plus a fake supplier that models what the supplier actually holds ("created" counts real
// supplier-side bookings, so tests can assert "exactly one booking exists", not just "one call was made").
const { assertValidTransition, requiresSupplierReference } = require("../../src/domain/bookingStateMachine");
const { Errors } = require("../../src/domain/errors");
const { DEFAULT_CAPABILITIES } = require("../../src/services/flightSupplier.interface");

function makeBookings() {
  const rows = new Map();
  const byKey = new Map();
  const faults = {};
  let n = 0;
  const maybeFail = (m) => { const f = faults[m]; if (f && f.times > 0) { f.times--; throw new Error(`DB unavailable (${m})`); } };
  const get = (id) => { const r = rows.get(id); if (!r) throw new Error(`booking ${id} not found`); return r; };
  const api = {
    rows, faults,
    failNext(method, times = 1) { faults[method] = { times }; },
    async findLiveForOffer(offerId) {
      maybeFail("findLiveForOffer");
      const LIVE = ["created", "pending", "processing", "ticketing_pending", "reconciliation_required", "confirmed"];
      const r = [...rows.values()].find((x) => x.offer_id === offerId && LIVE.includes(x.status));
      return r ? { ...r } : null;
    },
    async createOrGetExisting(a) {
      maybeFail("createOrGetExisting");
      const k = `${a.agencyId}|${a.idempotencyKey}`;
      if (!byKey.has(k)) {
        // mirror the database unique index (migration 021)
        const LIVE = ["created", "pending", "processing", "ticketing_pending", "reconciliation_required", "confirmed"];
        if ([...rows.values()].some((x) => x.offer_id === a.offerId && LIVE.includes(x.status))) {
          throw Object.assign(new Error('duplicate key value violates unique constraint "uniq_live_booking_per_offer"'), { code: "23505", constraint: "uniq_live_booking_per_offer" });
        }
      }
      if (byKey.has(k)) { const e = byKey.get(k); return { booking: { ...e }, isNew: false, hashMismatch: e.request_hash !== a.requestHash }; }
      const row = { id: `bk${++n}`, agency_id: a.agencyId, offer_id: a.offerId, type: a.type, status: "created", idempotency_key: a.idempotencyKey, supplier_code: a.supplierCode, request_hash: a.requestHash, supplier_reference: null, supplier_booking_id: null, submission_key: null, history: ["created"] };
      rows.set(row.id, row); byKey.set(k, row);
      return { booking: { ...row }, isNew: true, hashMismatch: false };
    },
    async beginSubmission(id, key) {
      maybeFail("beginSubmission");
      const r = get(id); assertValidTransition(r.status, "pending");
      Object.assign(r, { status: "pending", submission_key: key, submission_started_at: new Date() }); r.history.push("pending");
      return { ...r };
    },
    async transition(id, to, { supplierReference, actor, reason, metadata } = {}) {
      maybeFail("transition");
      const r = get(id); assertValidTransition(r.status, to);
      const ref = supplierReference || r.supplier_reference;
      if (requiresSupplierReference(to) && !ref) throw new Error("Cannot confirm a booking without a supplier confirmation reference");
      Object.assign(r, { status: to, supplier_reference: ref }); r.history.push(to); r.lastReason = reason; r.lastMetadata = metadata; r.lastActor = actor;
      return { ...r };
    },
    async recordSupplierAcceptance(id, ref) {
      maybeFail("recordSupplierAcceptance");
      const r = get(id); assertValidTransition(r.status, "processing");
      Object.assign(r, { status: "processing", supplier_booking_id: ref }); r.history.push("processing");
      return { ...r };
    },
    async recordSupplierAudit() { maybeFail("recordSupplierAudit"); },
    async bumpRecoveryAttempts(id) { get(id).recovery_attempts = (get(id).recovery_attempts || 0) + 1; },
    async markPolled(id, o) { get(id).polled = o; },
    get: (id) => ({ ...get(id) }),
  };
  return api;
}

// mode: accept | timeoutAfterAccept | timeoutBeforeAccept | dns | reject | parseErrorAfterAccept
function makeSupplier({ mode = "accept", caps = {} } = {}) {
  const s = {
    mode, bookCalls: [], created: 0, held: new Map(), live: { state: "in_progress" }, inFlight: 0, maxInFlight: 0,
    capabilities: { ...DEFAULT_CAPABILITIES, asyncBooking: true, sandbox: false, ...caps },
    async book(ref, pax, contact, ctx) {
      s.bookCalls.push(ctx.idempotencyKey);
      const create = () => { s.created++; const id = `sup-${s.created}`; s.held.set(ctx.idempotencyKey, id); return id; };
      switch (s.mode) {
        case "accept": return { supplierBookingRef: create(), status: "accepted", raw: {} };
        case "timeoutAfterAccept": create(); throw Errors.SupplierTimeout("response lost");
        case "timeoutBeforeAccept": throw Errors.SupplierTimeout("never reached");
        case "dns": throw Errors.SupplierUnavailable("LetsFG request failed: getaddrinfo EAI_AGAIN letsfg.co");
        case "reject": { const e = new Error("LetsFG 422 on /book"); e.code = "SUPPLIER_REJECTED"; e.httpStatus = 422; throw e; }
        case "parseErrorAfterAccept": create(); throw new TypeError("Cannot read properties of undefined (reading 'booking_id')");
        default: throw new Error(`unknown mode ${s.mode}`);
      }
    },
    async getBooking() {
      s.inFlight++; s.maxInFlight = Math.max(s.maxInFlight, s.inFlight);
      await new Promise((r) => setImmediate(r));
      s.inFlight--;
      return s.live;
    },
    async findBookingByKey(key) { return s.held.has(key) ? { supplierBookingRef: s.held.get(key) } : null; },
  };
  return s;
}

function bookingDeps({ Bookings, supplier, offer }) {
  const o = offer || { id: "off1", supplier_code: "x", supplier_offer_ref: "so1", expires_at: new Date(Date.now() + 3600e3), payload: {} };
  return {
    Offers: { get: async () => o },
    Bookings,
    getSupplier: () => supplier,
    hashRequestBody: (b) => JSON.stringify(b),
    newId: () => "corr-1",
  };
}

module.exports = { makeBookings, makeSupplier, bookingDeps };
