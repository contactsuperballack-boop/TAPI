// Integration tests for Sprint 8 (trip approvals + tenant isolation). NOT YET RUN —
// needs Postgres + `npm install`. Run: TEST_DATABASE_URL=postgres://... npm test -- trips
const request = require("supertest");
const { resetDatabase, seedAgency, closeDb } = require("./setup");

let app, A, B, db;
const OFFER = "11111111-1111-4111-8111-111111111111";
const auth = (k) => ({ Authorization: `Bearer ${k}` });

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  process.env.LETSFG_AUTH_MODE = "pfs";
  process.env.LETSFG_BEARER_TOKEN = "test-token";
  await resetDatabase();
  A = await seedAgency("Trips A");
  B = await seedAgency("Trips B");
  app = require("../src/app");
  db = require("../src/db");
});
afterAll(closeDb);

async function tripWithItem(agency, price = 500) {
  const t = await request(app).post("/v1/trips").set(auth(agency.apiKey)).send({ title: "London" });
  const { rows } = await db.query(
    `INSERT INTO agent_trip_items (agency_id, trip_id, kind, status, offer_id, quoted_price, currency)
     VALUES ($1,$2,'flight','proposed',$3,$4,'USD') RETURNING id`, [agency.agencyId, t.body.id, OFFER, price]);
  return { tripId: t.body.id, itemId: rows[0].id };
}

test("approve requires confirm:true and the exact quoted price and currency", async () => {
  const { tripId, itemId } = await tripWithItem(A);
  const url = `/v1/trips/${tripId}/items/${itemId}/approve`;
  expect((await request(app).post(url).set(auth(A.apiKey)).send({ acknowledgedPrice: 500, currency: "USD" })).status).toBe(400);
  expect((await request(app).post(url).set(auth(A.apiKey)).send({ confirm: true, acknowledgedPrice: 450, currency: "USD" })).status).toBe(409);
  expect((await request(app).post(url).set(auth(A.apiKey)).send({ confirm: true, acknowledgedPrice: 500, currency: "EUR" })).status).toBe(409);
  const ok = await request(app).post(url).set(auth(A.apiKey)).send({ confirm: true, acknowledgedPrice: 500, currency: "USD" });
  expect(ok.status).toBe(201);
  expect(ok.body.approvalId).toBeTruthy();
});

test("a second approval of the same item is refused while one is active", async () => {
  const { tripId, itemId } = await tripWithItem(A);
  const url = `/v1/trips/${tripId}/items/${itemId}/approve`;
  const body = { confirm: true, acknowledgedPrice: 500, currency: "USD" };
  await request(app).post(url).set(auth(A.apiKey)).send(body);
  // item is 'approved' with a live approval: the partial unique index refuses a second one
  const again = await request(app).post(url).set(auth(A.apiKey)).send(body);
  expect(again.status).toBe(409);
  expect(again.body.code).toBe("ALREADY_APPROVED");
});

test("tenant isolation: agency B cannot read, approve or book agency A's trip", async () => {
  const { tripId, itemId } = await tripWithItem(A);
  expect((await request(app).get(`/v1/trips/${tripId}`).set(auth(B.apiKey))).status).toBe(404);
  expect((await request(app).post(`/v1/trips/${tripId}/items/${itemId}/approve`).set(auth(B.apiKey)).send({ confirm: true, acknowledgedPrice: 500, currency: "USD" })).status).toBe(404);
  const r = await request(app).post(`/v1/trips/${tripId}/items/${itemId}/book`).set(auth(B.apiKey)).set("Idempotency-Key", "k1").send({ approvalId: "22222222-2222-4222-8222-222222222222" });
  expect(r.status).toBe(404);
});

test("book without an approval id, or with another item's approval, starts nothing", async () => {
  const one = await tripWithItem(A);
  const two = await tripWithItem(A);
  const ap = await request(app).post(`/v1/trips/${two.tripId}/items/${two.itemId}/approve`).set(auth(A.apiKey)).send({ confirm: true, acknowledgedPrice: 500, currency: "USD" });
  const missing = await request(app).post(`/v1/trips/${one.tripId}/items/${one.itemId}/book`).set(auth(A.apiKey)).set("Idempotency-Key", "k2").send({});
  expect(missing.status).toBe(400);
  const wrongItem = await request(app).post(`/v1/trips/${one.tripId}/items/${one.itemId}/book`).set(auth(A.apiKey)).set("Idempotency-Key", "k3").send({ approvalId: ap.body.approvalId });
  expect(wrongItem.status).toBe(404);
});

test("atomic consume: of two concurrent consumes exactly one wins", async () => {
  const { TripApprovals } = require("../src/repositories/tripApprovals");
  const { tripId, itemId } = await tripWithItem(A);
  const ap = await request(app).post(`/v1/trips/${tripId}/items/${itemId}/approve`).set(auth(A.apiKey)).send({ confirm: true, acknowledgedPrice: 500, currency: "USD" });
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => TripApprovals.consume(ap.body.approvalId, A.agencyId)));
  expect(results.filter(Boolean)).toHaveLength(1);
});

test("an expired approval can be replaced by approving again", async () => {
  const { tripId, itemId } = await tripWithItem(A);
  const url = `/v1/trips/${tripId}/items/${itemId}/approve`;
  const body = { confirm: true, acknowledgedPrice: 500, currency: "USD" };
  await request(app).post(url).set(auth(A.apiKey)).send(body);
  await db.query(`UPDATE agent_trip_approvals SET expires_at = now() - interval '1 minute' WHERE trip_item_id = $1`, [itemId]);
  // expired but still status 'active' in the table: approving again must expire it and issue a new one
  const again = await request(app).post(url).set(auth(A.apiKey)).send(body);
  expect(again.status).toBe(201);
  const rows = await db.query(`SELECT status FROM agent_trip_approvals WHERE trip_item_id = $1 ORDER BY created_at`, [itemId]);
  expect(rows.rows.map((r) => r.status)).toEqual(["expired", "active"]);
});

test("list, add-offer-to-trip (server-side price), travellers (masked passport), events", async () => {
  const s = await db.query(`INSERT INTO searches (agency_id, type, criteria, status) VALUES ($1,'flight','{}','completed') RETURNING id`, [A.agencyId]);
  const o = await db.query(
    `INSERT INTO offers (search_id, agency_id, type, supplier_code, supplier_offer_ref, price, currency, payload, expires_at)
     VALUES ($1,$2,'flight','letsfg','ref-ui-1',321.5,'USD','{"airline":"BA","stops":0}', now() + interval '1 hour') RETURNING id`, [s.rows[0].id, A.agencyId]);
  const t = await request(app).post("/v1/trips").set(auth(A.apiKey)).send({ title: "UI trip", startDate: "2026-12-10", endDate: "2026-12-17" });
  expect(t.body.start_date).toBe("2026-12-10");                      // plain text, no timezone shift
  const add = await request(app).post(`/v1/trips/${t.body.id}/items`).set(auth(A.apiKey)).send({ kind: "flight", offerId: o.rows[0].id, price: 1 });
  expect(add.status).toBe(201);
  expect(Number(add.body.quoted_price)).toBe(321.5);               // the body's price: 1 is ignored
  expect((await request(app).post(`/v1/trips/${t.body.id}/items`).set(auth(B.apiKey)).send({ kind: "flight", offerId: o.rows[0].id })).status).toBe(404);
  expect((await request(app).post(`/v1/trips/${t.body.id}/items`).set(auth(A.apiKey)).send({ kind: "hotel", offerId: o.rows[0].id })).status).toBe(404);
  const list = await request(app).get("/v1/trips").set(auth(A.apiKey));
  expect(list.body.trips.find((x) => x.id === t.body.id).item_count).toBe(1);
  const tr = await request(app).post("/v1/travelers").set(auth(A.apiKey)).send({ firstName: "Ada", lastName: "Obi", email: "ada@example.com", passportNumber: "A12345678", dateOfBirth: "1990-01-02", nationality: "NG" });
  expect(tr.status).toBe(201);
  expect(JSON.stringify(tr.body)).not.toContain("A12345678");
  expect(tr.body.passportMasked).toMatch(/678$/);
  expect(tr.body.dateOfBirth).toBe("1990-01-02");
  expect((await request(app).get("/v1/travelers").set(auth(A.apiKey))).body.travelers[0].dateOfBirth).toBe("1990-01-02");
  expect((await request(app).get("/v1/travelers").set(auth(B.apiKey))).body.travelers).toHaveLength(0);
  const ev = await request(app).get(`/v1/trips/${t.body.id}/events`).set(auth(A.apiKey));
  expect(ev.body.events.some((e) => e.type === "item_proposed")).toBe(true);
  const msg = await request(app).post(`/v1/trips/${t.body.id}/messages`).set(auth(A.apiKey)).send({ message: "hi" });
  expect(msg.status).toBe(503);
  expect(msg.body.code).toBe("AGENT_MODEL_NOT_CONFIGURED");
});
