// Integration tests for Sprint 10.4 repository behaviour against a REAL throwaway Postgres.
// NOT YET RUN by the author (no Postgres in the authoring environment) — CI's `integration` job is the first run.
// Run: TEST_DATABASE_URL=postgres://... npx jest tests/crashRecovery.db.test.js
const { resetDatabase, seedAgency, closeDb } = require("./setup");

let db, Searches, Offers, Bookings, Outbox, recoverOrphan, agencyId, n = 0;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  await resetDatabase();
  ({ agencyId } = await seedAgency("Recovery Agency"));
  db = require("../src/db");
  ({ Searches, Offers, Bookings, Outbox } = require("../src/repositories"));
  ({ recoverOrphan } = require("../src/services/submissionRecovery"));
});
afterAll(async () => { await closeDb(); });

async function newBooking() {
  n++;
  const search = await Searches.create({ agencyId, type: "flight", criteria: {}, supplierSearchRef: `s${n}`, supplierCode: "letsfg" });
  const [offer] = await Offers.bulkInsert(search.id, agencyId, "flight", "letsfg", [{ supplierOfferRef: `o${n}`, price: 100, currency: "USD", expiresAt: new Date(Date.now() + 3600e3).toISOString() }]);
  const { booking } = await Bookings.createOrGetExisting({ agencyId, offerId: offer.id, type: "flight", idempotencyKey: `k${n}`, supplierCode: "letsfg", travelerIds: [], correlationId: `c${n}`, requestHash: `h${n}` });
  return booking;
}
const row = async (id) => (await db.query("SELECT * FROM bookings WHERE id=$1", [id])).rows[0];
const outboxFor = async (id) => (await db.query("SELECT * FROM booking_outbox WHERE booking_id=$1 ORDER BY created_at", [id])).rows;

test("searches record which supplier ran them", async () => {
  const s = await Searches.create({ agencyId, type: "flight", criteria: {}, supplierSearchRef: "x", supplierCode: "tiqwa" });
  expect(s.supplier_code).toBe("tiqwa");
});

test("beginSubmission: created -> pending with the intent stored, and illegal repeats are rejected", async () => {
  const b = await newBooking();
  const p = await Bookings.beginSubmission(b.id, `tapi-bk-${b.id}`);
  expect(p.status).toBe("pending");
  expect(p.submission_key).toBe(`tapi-bk-${b.id}`);
  expect(p.submission_started_at).not.toBeNull();
  await expect(Bookings.beginSubmission(b.id, "again")).rejects.toThrow(/Invalid booking state transition/);
});

test("recordSupplierAcceptance: stores the supplier id and moves to processing atomically", async () => {
  const b = await newBooking();
  await Bookings.beginSubmission(b.id, `tapi-bk-${b.id}`);
  const u = await Bookings.recordSupplierAcceptance(b.id, "sup-123");
  expect(u.status).toBe("processing");
  expect(u.supplier_booking_id).toBe("sup-123");
  expect(u.supplier_reference).toBeNull(); // evidence reference stays empty until a PNR exists
  const hist = await db.query("SELECT to_status FROM booking_state_transitions WHERE booking_id=$1 ORDER BY created_at", [b.id]);
  expect(hist.rows.map((r) => r.to_status)).toEqual(["created", "pending", "processing"]);
});

test("confirming keeps the supplier booking id and puts the PNR in supplier_reference; outbox row written once", async () => {
  const b = await newBooking();
  await Bookings.beginSubmission(b.id, `tapi-bk-${b.id}`);
  await Bookings.recordSupplierAcceptance(b.id, "sup-777");
  const c = await Bookings.transition(b.id, "confirmed", { supplierReference: "PNR999", actor: "test" });
  expect(c.supplier_booking_id).toBe("sup-777");
  expect(c.supplier_reference).toBe("PNR999");
  const ev = await outboxFor(b.id);
  expect(ev.map((e) => e.event_type)).toEqual(["booking.confirmed"]);
  expect(ev[0].dedupe_key).toBe(`${b.id}:confirmed`);
});

test("ticketing_pending is accepted by the database CHECK constraint", async () => {
  const b = await newBooking();
  await Bookings.beginSubmission(b.id, `tapi-bk-${b.id}`);
  await Bookings.recordSupplierAcceptance(b.id, "sup-t");
  const t = await Bookings.transition(b.id, "ticketing_pending", { actor: "test" });
  expect(t.status).toBe("ticketing_pending");
});

test("findSubmissionOrphans: only old pending bookings without a supplier id", async () => {
  const old = await newBooking(); await Bookings.beginSubmission(old.id, "k-old");
  await db.query("UPDATE bookings SET submission_started_at = now() - interval '10 minutes' WHERE id=$1", [old.id]);
  const fresh = await newBooking(); await Bookings.beginSubmission(fresh.id, "k-fresh");
  const accepted = await newBooking(); await Bookings.beginSubmission(accepted.id, "k-acc"); await Bookings.recordSupplierAcceptance(accepted.id, "sup-a");
  await db.query("UPDATE bookings SET submission_started_at = now() - interval '10 minutes' WHERE id=$1", [accepted.id]);
  const ids = (await Bookings.findSubmissionOrphans(3, 50)).map((r) => r.id);
  expect(ids).toContain(old.id);
  expect(ids).not.toContain(fresh.id);
  expect(ids).not.toContain(accepted.id);
});

test("recovery against the real repository: no lookup capability -> reconciliation_required + outbox event, key preserved", async () => {
  const b = await newBooking(); await Bookings.beginSubmission(b.id, `tapi-bk-${b.id}`);
  const supplier = { capabilities: { lookupByKey: false }, book: () => { throw new Error("must not re-submit"); } };
  const r = await recoverOrphan(await row(b.id), { Bookings, getSupplier: () => supplier });
  expect(r.action).toBe("escalated");
  expect((await row(b.id)).status).toBe("reconciliation_required");
  const ev = await outboxFor(b.id);
  expect(ev.map((e) => e.event_type)).toContain("booking.reconciliation_required");
  const meta = await db.query("SELECT metadata FROM booking_state_transitions WHERE booking_id=$1 AND to_status='reconciliation_required'", [b.id]);
  expect(meta.rows[0].metadata.submissionKey).toBe(`tapi-bk-${b.id}`);
});

test("recovery with an authoritative lookup that finds the booking resumes it as processing", async () => {
  const b = await newBooking(); await Bookings.beginSubmission(b.id, `tapi-bk-${b.id}`);
  const supplier = { capabilities: { lookupByKey: true }, findBookingByKey: async () => ({ supplierBookingRef: "sup-found" }) };
  await recoverOrphan(await row(b.id), { Bookings, getSupplier: () => supplier });
  const after = await row(b.id);
  expect(after.status).toBe("processing");
  expect(after.supplier_booking_id).toBe("sup-found");
});

test("findDueForPolling honours next_poll_at; markPolled does not touch updated_at", async () => {
  const b = await newBooking(); await Bookings.beginSubmission(b.id, "k-poll"); await Bookings.recordSupplierAcceptance(b.id, "sup-p");
  expect((await Bookings.findDueForPolling(100)).map((r) => r.id)).toContain(b.id);
  const before = (await row(b.id)).updated_at;
  await Bookings.markPolled(b.id, { attempts: 1, nextPollAt: new Date(Date.now() + 600e3) });
  expect((await Bookings.findDueForPolling(100)).map((r) => r.id)).not.toContain(b.id);
  const after = await row(b.id);
  expect(after.poll_attempts).toBe(1);
  expect(new Date(after.updated_at).getTime()).toBe(new Date(before).getTime());
});

test("outbox: claims are leased (no double delivery), concurrent claimers never share a row, retry and delivery update state", async () => {
  const b = await newBooking();
  for (let i = 0; i < 6; i++) {
    await db.query("INSERT INTO booking_outbox (booking_id, agency_id, event_type, dedupe_key) VALUES ($1,$2,'booking.test',$3)", [b.id, agencyId, `ob-${b.id}-${i}`]);
  }
  const [a, c] = await Promise.all([Outbox.claimBatch(3), Outbox.claimBatch(3)]);
  const ids = [...a, ...c].map((r) => r.id);
  expect(new Set(ids).size).toBe(ids.length); // disjoint
  expect((await Outbox.claimBatch(10)).filter((r) => r.booking_id === b.id).length).toBeLessThanOrEqual(0); // all leased
  await Outbox.markDelivered(ids[0]);
  await Outbox.scheduleRetry(ids[1], 600000, "boom");
  const rows = (await db.query("SELECT * FROM booking_outbox WHERE id = ANY($1)", [[ids[0], ids[1]]])).rows;
  expect(rows.find((r) => r.id === ids[0]).delivered_at).not.toBeNull();
  expect(rows.find((r) => r.id === ids[1]).last_error).toBe("boom");
});

test("outbox dedupe_key is unique", async () => {
  const b = await newBooking();
  await db.query("INSERT INTO booking_outbox (booking_id, event_type, dedupe_key) VALUES ($1,'booking.x','dup-1')", [b.id]);
  await expect(db.query("INSERT INTO booking_outbox (booking_id, event_type, dedupe_key) VALUES ($1,'booking.x','dup-1')", [b.id])).rejects.toThrow(/duplicate key/);
});

test("one live booking per offer: a second booking for the same offer is rejected by the database; a failed one frees it", async () => {
  const b1 = await newBooking();
  await expect(Bookings.createOrGetExisting({ agencyId, offerId: b1.offer_id, type: "flight", idempotencyKey: "second-key", supplierCode: "letsfg", travelerIds: [], correlationId: "c", requestHash: "h" }))
    .rejects.toThrow(/uniq_live_booking_per_offer/);
  expect((await Bookings.findLiveForOffer(b1.offer_id)).id).toBe(b1.id);
  await Bookings.beginSubmission(b1.id, "k-free");
  await Bookings.transition(b1.id, "failed", { actor: "test", reason: "definitive refusal" });
  expect(await Bookings.findLiveForOffer(b1.offer_id)).toBeNull();
  const again = await Bookings.createOrGetExisting({ agencyId, offerId: b1.offer_id, type: "flight", idempotencyKey: "after-failure", supplierCode: "letsfg", travelerIds: [], correlationId: "c2", requestHash: "h2" });
  expect(again.isNew).toBe(true);
});
