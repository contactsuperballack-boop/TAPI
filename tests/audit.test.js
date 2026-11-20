// Integration tests for the audit response (passport encryption, under-review items, retry window, claimer binding,
// 4xx instead of 500). NOT YET RUN here (needs Postgres + `npm install`): TEST_DATABASE_URL=postgres://... npm test -- audit
const request = require("supertest");
const { resetDatabase, seedAgency, closeDb } = require("./setup");

let app, db, A, mailer, Fulfilment, sqlRepo, run, getFieldCrypto;
const PW = "kettle-orbit-lantern";
const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const tokenFrom = (m) => decodeURIComponent(m.text.match(/token=([^\s]+)/)[1]);

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  process.env.MAIL_TRANSPORT = "memory"; process.env.INTERNAL_SERVICE_TOKEN = "z".repeat(40);
  await resetDatabase();
  A = await seedAgency("Audit A");
  app = require("../src/app"); db = require("../src/db");
  mailer = require("../src/services/mailer").getMailer();
  ({ Fulfilment } = require("../src/repositories/fulfilment")); ({ sqlRepo, run } = require("../scripts/encrypt-passports")); ({ getFieldCrypto } = require("../src/services/fieldCrypto"));
});
afterAll(closeDb);

async function staff(email, role = "agent") {
  await request(app).post("/v1/staff").set(bearer(A.apiKey)).send({ email, fullName: "Staff Member", role });
  await request(app).post("/v1/account/password-reset/confirm").send({ token: tokenFrom(mailer.outbox.at(-1)), password: PW });
  return (await request(app).post("/v1/account/login").send({ email, password: PW })).body;
}
const newClient = (agent, extra = {}) => request(app).post("/v1/travelers").set(bearer(agent.token)).send({ firstName: "Chi", lastName: "Eze", email: `c${Math.random()}@example.com`, dateOfBirth: "1985-05-05", nationality: "ng", passportNumber: "B7654321", ...extra });
async function itemUnderReview(agent) {
  const client = (await newClient(agent)).body;
  const trip = (await request(app).post("/v1/trips").set(bearer(agent.token)).send({ title: "Review me", travelerId: client.id })).body;
  const s = await db.query(`INSERT INTO searches (agency_id, type, criteria, status) VALUES ($1,'flight','{}','completed') RETURNING id`, [A.agencyId]);
  const o = await db.query(`INSERT INTO offers (search_id, agency_id, type, supplier_code, supplier_offer_ref, price, currency, payload, expires_at) VALUES ($1,$2,'flight','letsfg',$3,500,'USD','{}', now() + interval '1 hour') RETURNING id`, [s.rows[0].id, A.agencyId, `r-${Math.random()}`]);
  const item = (await request(app).post(`/v1/trips/${trip.id}/items`).set(bearer(agent.token)).send({ kind: "flight", offerId: o.rows[0].id })).body;
  await db.query(`UPDATE agent_trip_items SET status='reconciliation_required' WHERE id=$1`, [item.id]);
  return { trip, item };
}

test("passports are encrypted at rest: no plaintext in the database, masked in responses, readable only by the reveal/booking paths", async () => {
  const agent = await staff("enc@acme.test");
  const c = await newClient(agent); expect(c.status).toBe(201);
  expect(JSON.stringify(c.body)).not.toContain("B7654321"); expect(c.body.passportMasked).toMatch(/321$/); expect(c.body.missingForFlights).toEqual([]);
  const row = (await db.query(`SELECT passport_number, passport_number_enc, passport_last4 FROM travelers WHERE id=$1`, [c.body.id])).rows[0];
  expect(row.passport_number).toBeNull(); expect(row.passport_number_enc).toMatch(/^v1\./); expect(row.passport_number_enc).not.toContain("B7654321"); expect(row.passport_last4).toBe("4321");
  expect((await Fulfilment.travellerDetails(c.body.id, A.agencyId)).passport_number).toBe("B7654321");
  const upd = await request(app).patch(`/v1/travelers/${c.body.id}`).set(bearer(agent.token)).send({ passportNumber: "c1111111" });
  expect(upd.status).toBe(200); expect(upd.body.passportMasked).toMatch(/111$/);
  expect((await Fulfilment.travellerDetails(c.body.id, A.agencyId)).passport_number).toBe("C1111111");
  const list = await request(app).get("/v1/travelers").set(bearer(agent.token)); expect(JSON.stringify(list.body)).not.toMatch(/C1111111|B7654321/);
});

test("a ciphertext copied onto another traveller does not decrypt (bound to its record)", async () => {
  const agent = await staff("bind@acme.test"); const a = (await newClient(agent)).body, b = (await newClient(agent, { passportNumber: "D2222222" })).body;
  await db.query(`UPDATE travelers SET passport_number_enc = (SELECT passport_number_enc FROM travelers WHERE id=$1) WHERE id=$2`, [a.id, b.id]);
  await expect(Fulfilment.travellerDetails(b.id, A.agencyId)).rejects.toMatchObject({ code: "DECRYPT_FAILED" });
});

test("legacy plaintext rows keep working until the backfill, which encrypts them and clears the plaintext", async () => {
  const agent = await staff("legacy@acme.test"); const c = (await newClient(agent, { passportNumber: undefined })).body;
  await db.query(`UPDATE travelers SET passport_number='Z9999999' WHERE id=$1`, [c.id]);
  expect((await request(app).get("/v1/travelers").set(bearer(agent.token))).body.travelers.find((t) => t.id === c.id).passportMasked).toMatch(/999$/);
  const out = await run({ repo: sqlRepo(db), crypto: getFieldCrypto(), log: () => {} });
  expect(out.failed).toBe(0); expect(out.done).toBeGreaterThanOrEqual(1);
  const row = (await db.query(`SELECT passport_number, passport_number_enc FROM travelers WHERE id=$1`, [c.id])).rows[0];
  expect(row.passport_number).toBeNull(); expect(row.passport_number_enc).toMatch(/^v1\./);
  expect((await Fulfilment.travellerDetails(c.id, A.agencyId)).passport_number).toBe("Z9999999");
});

test("an item under review can be resolved by staff only: confirmed needs the supplier reference; not_booked sends it back to the traveller", async () => {
  const agent = await staff("res@acme.test"); const { trip, item } = await itemUnderReview(agent);
  const url = `/v1/trips/${trip.id}/items/${item.id}/resolve`;
  expect((await request(app).post(url).set(bearer(agent.token)).send({ outcome: "confirmed" })).status).toBe(400);
  expect((await request(app).post(url).set(bearer(agent.token)).send({ outcome: "banana" })).status).toBe(400);
  const ok = await request(app).post(url).set(bearer(agent.token)).send({ outcome: "confirmed", reference: "SUP-123", note: "checked" });
  expect(ok.status).toBe(200); expect(ok.body.status).toBe("confirmed");
  const t = (await request(app).get(`/v1/trips/${trip.id}`).set(bearer(agent.token))).body; expect(t.items[0].status).toBe("confirmed"); expect(t.items[0].confirmation_ref).toBe("SUP-123");
  expect((await request(app).post(url).set(bearer(agent.token)).send({ outcome: "not_booked" })).status).toBe(409);          // no longer under review
  const two = await itemUnderReview(agent);
  expect((await request(app).post(`/v1/trips/${two.trip.id}/items/${two.item.id}/resolve`).set(bearer(agent.token)).send({ outcome: "not_booked", note: "Supplier has no record" })).body.status).toBe("selected");
  const ev = (await db.query(`SELECT payload FROM agent_trip_events WHERE trip_id=$1 AND type='booking_resolved'`, [trip.id])).rows; expect(ev).toHaveLength(1);
});

test("travellers cannot resolve items under review", async () => {
  const agent = await staff("res2@acme.test"); const { trip, item } = await itemUnderReview(agent);
  const house = (await db.query(`SELECT id FROM agencies WHERE kind='house'`)).rows[0].id;
  await request(app).post("/v1/account/signup").send({ email: "trav-res@example.com", password: PW, firstName: "T", lastName: "R" });
  const trav = (await request(app).post("/v1/account/login").send({ email: "trav-res@example.com", password: PW })).body;
  expect([403, 404]).toContain((await request(app).post(`/v1/trips/${trip.id}/items/${item.id}/resolve`).set(bearer(trav.token)).send({ outcome: "not_booked" })).status);
  expect(house).toBeTruthy();
});

test("a spent approval with no booking id is offered for a same-key retry only inside the window", async () => {
  const agent = await staff("retry@acme.test"); const { trip, item } = await itemUnderReview(agent);
  const ins = async (minutesAgo) => (await db.query(`INSERT INTO agent_trip_approvals (agency_id, trip_id, trip_item_id, offer_id, approved_price, currency, status, expires_at, consumed_at)
     VALUES ($1,$2,$3,'o',500,'USD','consumed', now() + interval '1 hour', now() - make_interval(mins => $4)) RETURNING id`, [A.agencyId, trip.id, item.id, minutesAgo])).rows[0].id;
  const fresh = await ins(2);
  expect((await request(app).get(`/v1/trips/${trip.id}`).set(bearer(agent.token))).body.items[0].retry_approval_id).toBe(fresh);
  await db.query(`UPDATE agent_trip_approvals SET consumed_at = now() - interval '2 hours' WHERE id=$1`, [fresh]);
  expect((await request(app).get(`/v1/trips/${trip.id}`).set(bearer(agent.token))).body.items[0].retry_approval_id).toBeNull();
});

test("claim-bound writes: if a request is released and claimed by someone else, the first agent's stale complete/decline/reprice/release all do nothing", async () => {
  const a1 = await staff("cb1@acme.test"), a2 = await staff("cb2@acme.test");
  const client = (await newClient(a1)).body; const trip = (await request(app).post("/v1/trips").set(bearer(a1.token)).send({ title: "CB", travelerId: client.id })).body;
  const s = await db.query(`INSERT INTO searches (agency_id, type, criteria, status) VALUES ($1,'flight','{}','completed') RETURNING id`, [A.agencyId]);
  const o = await db.query(`INSERT INTO offers (search_id, agency_id, type, supplier_code, supplier_offer_ref, price, currency, payload, expires_at) VALUES ($1,$2,'flight','letsfg',$3,500,'USD','{}', now() + interval '1 hour') RETURNING id`, [s.rows[0].id, A.agencyId, `r-${Math.random()}`]);
  const item = (await request(app).post(`/v1/trips/${trip.id}/items`).set(bearer(a1.token)).send({ kind: "flight", offerId: o.rows[0].id })).body;
  const ap = (await request(app).post(`/v1/trips/${trip.id}/items/${item.id}/approve`).set(bearer(a1.token)).send({ confirm: true, acknowledgedPrice: 500, currency: "USD", clientConsent: true, fulfilment: "agent_assisted" })).body;
  await request(app).post(`/v1/fulfilment/${ap.requestId}/claim`).set(bearer(a1.token));
  const staleView = await Fulfilment.get(ap.requestId, A.agencyId);                   // agent 1's view of the request
  await request(app).post(`/v1/fulfilment/${ap.requestId}/release`).set(bearer(a1.token));
  await request(app).post(`/v1/fulfilment/${ap.requestId}/claim`).set(bearer(a2.token));
  expect((await Fulfilment.complete(staleView, { confirmationRef: "STALE", finalPrice: 400, note: null })).ok).toBe(false);
  expect((await Fulfilment.decline(staleView, "stale")).ok).toBe(false);
  expect((await Fulfilment.reprice(staleView, { newPrice: 900, note: "stale" })).ok).toBe(false);
  expect(await Fulfilment.release(staleView.id, A.agencyId, staleView.claimed_by_user_id)).toBeNull();
  expect((await db.query(`SELECT status, claimed_by_user_id FROM fulfilment_requests WHERE id=$1`, [ap.requestId])).rows[0].status).toBe("claimed");
  expect((await db.query(`SELECT status FROM agent_trip_approvals WHERE id=$1`, [ap.approvalId])).rows[0].status).toBe("active");   // the failed complete rolled back its approval spend
});

test("malformed input is a 4xx, never a 500: bad JSON, bad UUIDs, oversized body", async () => {
  const agent = await staff("bad@acme.test");
  const badJson = await request(app).post("/v1/trips").set(bearer(agent.token)).set("Content-Type", "application/json").send("{not json");
  expect(badJson.status).toBe(400); expect(badJson.body.code).toBe("INVALID_REQUEST_BODY");
  for (const url of ["/v1/trips/not-a-uuid", "/v1/fulfilment/not-a-uuid", "/v1/travelers/not-a-uuid"]) { const r = await request(app).get(url).set(bearer(agent.token)); expect([400, 404]).toContain(r.status); }
  expect((await request(app).patch("/v1/travelers/----------------------------------------").set(bearer(agent.token)).send({})).status).toBe(404);
  const big = await request(app).post("/v1/trips").set(bearer(agent.token)).send({ title: "x".repeat(2_000_000) });
  expect([400, 413]).toContain(big.status);
});
