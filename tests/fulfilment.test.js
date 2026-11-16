// Integration tests for Sprint 9 / step 2 (agent-assisted bookings + queue). NOT YET RUN: needs Postgres + `npm install`.
//   TEST_DATABASE_URL=postgres://... npm test -- fulfilment
const request = require("supertest");
const { resetDatabase, seedAgency, closeDb } = require("./setup");

let app, db, A, B, mailer, hashPassword;
const PW = "kettle-orbit-lantern";
const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const tokenFrom = (m) => decodeURIComponent(m.text.match(/token=([^\s]+)/)[1]);
const lastMail = () => mailer.outbox[mailer.outbox.length - 1];

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  process.env.MAIL_TRANSPORT = "memory"; process.env.INTERNAL_SERVICE_TOKEN = "z".repeat(40);
  await resetDatabase();
  A = await seedAgency("Fulfilment A"); B = await seedAgency("Fulfilment B");
  app = require("../src/app"); db = require("../src/db");
  mailer = require("../src/services/mailer").getMailer(); ({ hashPassword } = require("../src/services/passwords"));
});
afterAll(closeDb);

async function agentFor(agency, email, role = "agent") {
  expect((await request(app).post("/v1/staff").set(bearer(agency.apiKey)).send({ email, fullName: "Staff Member", role })).status).toBe(201);
  expect((await request(app).post("/v1/account/password-reset/confirm").send({ token: tokenFrom(lastMail()), password: PW })).status).toBe(200);
  return (await request(app).post("/v1/account/login").send({ email, password: PW })).body;
}
async function seedOffer(agencyId, price = 500) {
  const s = await db.query(`INSERT INTO searches (agency_id, type, criteria, status) VALUES ($1,'flight','{}','completed') RETURNING id`, [agencyId]);
  return (await db.query(`INSERT INTO offers (search_id, agency_id, type, supplier_code, supplier_offer_ref, price, currency, payload, expires_at)
    VALUES ($1,$2,'flight','letsfg',$3,$4,'USD','{"airline":"BA"}', now() + interval '1 hour') RETURNING id`, [s.rows[0].id, agencyId, `ref-${Math.random()}`, price])).rows[0].id;
}
// agency A: a client with full details, a trip, one proposed item, approved with fulfilment=agent_assisted by `agent`.
async function requested(agent, { price = 500 } = {}) {
  const client = (await request(app).post("/v1/travelers").set(bearer(agent.token)).send({ firstName: "Chi", lastName: "Eze", email: `chi${Math.random()}@example.com`, passportNumber: "B7654321", nationality: "NG", dateOfBirth: "1985-05-05" })).body;
  const trip = (await request(app).post("/v1/trips").set(bearer(agent.token)).send({ title: "For Chi", travelerId: client.id })).body;
  const item = (await request(app).post(`/v1/trips/${trip.id}/items`).set(bearer(agent.token)).send({ kind: "flight", offerId: await seedOffer(A.agencyId, price) })).body;
  const ap = await request(app).post(`/v1/trips/${trip.id}/items/${item.id}/approve`).set(bearer(agent.token)).send({ confirm: true, acknowledgedPrice: price, currency: "USD", clientConsent: true, fulfilment: "agent_assisted", travellerNote: "Window seat please" });
  expect(ap.status).toBe(201);
  return { client, trip, item, ap: ap.body };
}

test("approving with fulfilment=agent_assisted queues a request, lengthens the approval, and blocks automated booking", async () => {
  const agent = await agentFor(A, "a1@acme.test");
  const { trip, item, ap } = await requested(agent);
  expect(ap.fulfilment).toBe("agent_assisted"); expect(ap.requestId).toBeTruthy();
  const t = (await request(app).get(`/v1/trips/${trip.id}`).set(bearer(agent.token))).body;
  expect(t.status).toBe("booking");
  expect(t.items[0].status).toBe("agent_requested"); expect(t.items[0].request_status).toBe("open");
  const hours = (await db.query(`SELECT EXTRACT(EPOCH FROM (expires_at - created_at))/3600 AS h FROM agent_trip_approvals WHERE id=$1`, [ap.approvalId])).rows[0].h;
  expect(Number(hours)).toBeGreaterThan(47);
  const book = await request(app).post(`/v1/trips/${trip.id}/items/${item.id}/book`).set(bearer(agent.token)).set("Idempotency-Key", "k1").send({ approvalId: ap.approvalId });
  expect(book.status).toBe(409); expect(book.body.code).toBe("HANDLED_BY_AGENT");
  const q = await request(app).get("/v1/fulfilment").set(bearer(agent.token));
  expect(q.body.requests.some((r) => r.id === ap.requestId && r.travellerNote === "Window seat please")).toBe(true);
});

test("claiming is atomic: of two agents claiming at once exactly one wins", async () => {
  const a1 = await agentFor(A, "c1@acme.test"), a2 = await agentFor(A, "c2@acme.test");
  const { ap } = await requested(a1);
  const [r1, r2] = await Promise.all([request(app).post(`/v1/fulfilment/${ap.requestId}/claim`).set(bearer(a1.token)), request(app).post(`/v1/fulfilment/${ap.requestId}/claim`).set(bearer(a2.token))]);
  expect([r1.status, r2.status].sort()).toEqual([200, 409]);
  const loser = r1.status === 409 ? r1 : r2; expect(loser.body.code).toBe("ALREADY_CLAIMED");
  expect((await db.query(`SELECT status FROM agent_trip_items WHERE id=(SELECT trip_item_id FROM fulfilment_requests WHERE id=$1)`, [ap.requestId])).rows[0].status).toBe("agent_working");
});

test("only the claimer (or an admin) can work a request; passport details are revealed only to them and every reveal is logged", async () => {
  const a1 = await agentFor(A, "w1@acme.test"), a2 = await agentFor(A, "w2@acme.test"), boss = await agentFor(A, "boss@acme.test", "admin");
  const { ap, trip } = await requested(a1);
  await request(app).post(`/v1/fulfilment/${ap.requestId}/claim`).set(bearer(a1.token));
  expect((await request(app).post(`/v1/fulfilment/${ap.requestId}/reveal`).set(bearer(a2.token))).status).toBe(403);
  const ok = await request(app).post(`/v1/fulfilment/${ap.requestId}/reveal`).set(bearer(a1.token));
  expect(ok.status).toBe(200); expect(ok.body.passportNumber).toBe("B7654321"); expect(ok.headers["cache-control"]).toMatch(/no-store/);
  expect((await request(app).post(`/v1/fulfilment/${ap.requestId}/reveal`).set(bearer(boss.token))).status).toBe(200);
  const ev = (await db.query(`SELECT payload FROM agent_trip_events WHERE trip_id=$1 AND type='pii_revealed'`, [trip.id])).rows;
  expect(ev).toHaveLength(2);
  expect((await request(app).post(`/v1/fulfilment/${ap.requestId}/decline`).set(bearer(a2.token)).send({ reason: "not mine" })).status).toBe(403);
});

test("completing above the approved price is refused and records nothing; at or below it confirms the item, spends the approval once, and emails the traveller", async () => {
  const agent = await agentFor(A, "p1@acme.test");
  const { ap, trip, item, client } = await requested(agent, { price: 500 });
  await request(app).post(`/v1/fulfilment/${ap.requestId}/claim`).set(bearer(agent.token));
  const over = await request(app).post(`/v1/fulfilment/${ap.requestId}/complete`).set(bearer(agent.token)).send({ confirmationRef: "ABC123", finalPrice: 520, currency: "USD" });
  expect(over.status).toBe(409); expect(over.body.code).toBe("PRICE_EXCEEDS_APPROVAL");
  expect((await db.query(`SELECT status FROM agent_trip_approvals WHERE id=$1`, [ap.approvalId])).rows[0].status).toBe("active");
  expect((await db.query(`SELECT status FROM fulfilment_requests WHERE id=$1`, [ap.requestId])).rows[0].status).toBe("claimed");
  expect((await request(app).post(`/v1/fulfilment/${ap.requestId}/complete`).set(bearer(agent.token)).send({ confirmationRef: "", finalPrice: 400, currency: "USD" })).status).toBe(400);
  const done = await request(app).post(`/v1/fulfilment/${ap.requestId}/complete`).set(bearer(agent.token)).send({ confirmationRef: "ABC123", finalPrice: 480.5, currency: "USD", note: "Seat 14A" });
  expect(done.status).toBe(200); expect(done.body.status).toBe("completed");
  const t = (await request(app).get(`/v1/trips/${trip.id}`).set(bearer(agent.token))).body;
  expect(t.status).toBe("booked"); expect(t.items[0].status).toBe("confirmed"); expect(t.items[0].confirmation_ref).toBe("ABC123"); expect(Number(t.items[0].quoted_price)).toBe(480.5); expect(t.items[0].price_label).toBe("confirmed");
  expect((await db.query(`SELECT status FROM agent_trip_approvals WHERE id=$1`, [ap.approvalId])).rows[0].status).toBe("consumed");
  expect((await request(app).post(`/v1/fulfilment/${ap.requestId}/complete`).set(bearer(agent.token)).send({ confirmationRef: "ABC123", finalPrice: 480.5, currency: "USD" })).status).toBe(409);
  expect(mailer.outbox.some((m) => m.to === client.email && /ABC123/.test(m.text))).toBe(true);
});

test("decline marks the item failed and revokes the approval; reprice sends it back for a fresh approval at the new price", async () => {
  const agent = await agentFor(A, "d1@acme.test");
  const d = await requested(agent); await request(app).post(`/v1/fulfilment/${d.ap.requestId}/claim`).set(bearer(agent.token));
  expect((await request(app).post(`/v1/fulfilment/${d.ap.requestId}/decline`).set(bearer(agent.token)).send({ reason: "no" })).status).toBe(400);
  expect((await request(app).post(`/v1/fulfilment/${d.ap.requestId}/decline`).set(bearer(agent.token)).send({ reason: "Sold out on that flight" })).status).toBe(200);
  expect((await db.query(`SELECT status FROM agent_trip_items WHERE id=$1`, [d.item.id])).rows[0].status).toBe("failed");
  expect((await db.query(`SELECT status FROM agent_trip_approvals WHERE id=$1`, [d.ap.approvalId])).rows[0].status).toBe("revoked");
  expect((await request(app).get(`/v1/trips/${d.trip.id}`).set(bearer(agent.token))).body.status).toBe("needs_attention");

  const r = await requested(agent); await request(app).post(`/v1/fulfilment/${r.ap.requestId}/claim`).set(bearer(agent.token));
  expect((await request(app).post(`/v1/fulfilment/${r.ap.requestId}/reprice`).set(bearer(agent.token)).send({ newPrice: 560, note: "Fare class sold out" })).status).toBe(200);
  const t = (await request(app).get(`/v1/trips/${r.trip.id}`).set(bearer(agent.token))).body;
  expect(t.items[0].status).toBe("selected"); expect(Number(t.items[0].quoted_price)).toBe(560); expect(t.status).toBe("itinerary_ready");
  const again = await request(app).post(`/v1/trips/${r.trip.id}/items/${r.item.id}/approve`).set(bearer(agent.token)).send({ confirm: true, acknowledgedPrice: 560, currency: "USD", clientConsent: true, fulfilment: "agent_assisted" });
  expect(again.status).toBe(201); expect(again.body.requestId).not.toBe(r.ap.requestId);
});

test("withdrawing: allowed while the request is open, refused once an agent has started", async () => {
  const agent = await agentFor(A, "x1@acme.test");
  const o = await requested(agent);
  const w = await request(app).post(`/v1/trips/${o.trip.id}/items/${o.item.id}/cancel-request`).set(bearer(agent.token));
  expect(w.status).toBe(200);
  const t = (await request(app).get(`/v1/trips/${o.trip.id}`).set(bearer(agent.token))).body;
  expect(t.items[0].status).toBe("selected"); expect(t.status).toBe("itinerary_ready");
  const c = await requested(agent); await request(app).post(`/v1/fulfilment/${c.ap.requestId}/claim`).set(bearer(agent.token));
  const late = await request(app).post(`/v1/trips/${c.trip.id}/items/${c.item.id}/cancel-request`).set(bearer(agent.token));
  expect(late.status).toBe(409); expect(late.body.code).toBe("ALREADY_STARTED");
});

test("direct travellers (house agency): cannot reach the queue; see their request status; self-booking off forces the agent route", async () => {
  const house = (await db.query(`SELECT id FROM agencies WHERE kind='house'`)).rows[0].id;
  const u = (await db.query(`INSERT INTO users (email, password_hash, full_name, email_verified_at) VALUES ('house.agent@tapi.test',$1,'House Agent',now()) RETURNING id`, [await hashPassword(PW)])).rows[0];
  await db.query(`INSERT INTO memberships (user_id, agency_id, role) VALUES ($1,$2,'agent')`, [u.id, house]);
  const houseAgent = (await request(app).post("/v1/account/login").send({ email: "house.agent@tapi.test", password: PW })).body;
  await request(app).post("/v1/account/signup").send({ email: "dir@example.com", password: PW, firstName: "Dee", lastName: "Rect" });
  await request(app).post("/v1/account/verify-email").send({ token: tokenFrom(lastMail()) });
  const trav = (await request(app).post("/v1/account/login").send({ email: "dir@example.com", password: PW })).body;
  expect((await request(app).get("/v1/fulfilment").set(bearer(trav.token))).status).toBe(403);
  const trip = (await request(app).post("/v1/trips").set(bearer(trav.token)).send({ title: "Mine" })).body;
  const item = (await request(app).post(`/v1/trips/${trip.id}/items`).set(bearer(trav.token)).send({ kind: "flight", offerId: await seedOffer(house) })).body;
  const ap = await request(app).post(`/v1/trips/${trip.id}/items/${item.id}/approve`).set(bearer(trav.token)).send({ confirm: true, acknowledgedPrice: 500, currency: "USD", fulfilment: "agent_assisted" });
  expect(ap.status).toBe(201);
  await request(app).post(`/v1/fulfilment/${ap.body.requestId}/claim`).set(bearer(houseAgent.token));
  const seen = (await request(app).get(`/v1/trips/${trip.id}`).set(bearer(trav.token))).body.items[0];
  expect(seen.status).toBe("agent_working"); expect(seen.request_agent_name).toBe("House Agent");
  // policy: self-booking off -> a traveller who asks for nothing is routed to an agent; explicitly asking for automated is refused
  await db.query(`UPDATE agencies SET traveller_self_booking=false WHERE id=$1`, [house]);
  try {
    const item2 = (await request(app).post(`/v1/trips/${trip.id}/items`).set(bearer(trav.token)).send({ kind: "flight", offerId: await seedOffer(house, 300) })).body;
    const body = { confirm: true, acknowledgedPrice: 300, currency: "USD" };
    const auto = await request(app).post(`/v1/trips/${trip.id}/items/${item2.id}/approve`).set(bearer(trav.token)).send({ ...body, fulfilment: "automated" });
    expect(auto.status).toBe(403); expect(auto.body.code).toBe("SELF_BOOKING_DISABLED");
    const forced = await request(app).post(`/v1/trips/${trip.id}/items/${item2.id}/approve`).set(bearer(trav.token)).send(body);
    expect(forced.status).toBe(201); expect(forced.body.fulfilment).toBe("agent_assisted");
  } finally { await db.query(`UPDATE agencies SET traveller_self_booking=true WHERE id=$1`, [house]); }
});

test("tenant isolation: another agency's agent cannot see, claim or reveal this request", async () => {
  const a = await agentFor(A, "iso-a@acme.test"), b = await agentFor(B, "iso-b@other.test");
  const { ap } = await requested(a);
  expect((await request(app).get("/v1/fulfilment").set(bearer(b.token))).body.requests).toHaveLength(0);
  for (const [m, u] of [["get", ""], ["post", "/claim"], ["post", "/reveal"], ["post", "/complete"]]) expect((await request(app)[m](`/v1/fulfilment/${ap.requestId}${u}`).set(bearer(b.token)).send({})).status).toBe(404);
});
