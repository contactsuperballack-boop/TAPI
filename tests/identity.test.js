// Integration tests for Sprint 9 step 1 (accounts, roles, scoping). NOT YET RUN: needs Postgres + `npm install`.
//   TEST_DATABASE_URL=postgres://... npm test -- identity
const request = require("supertest");
const { resetDatabase, seedAgency, closeDb } = require("./setup");

let app, db, A, mailer;
const PW = "kettle-orbit-lantern";
const OFFER_FLIGHT_REF = "ref-id-1";

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  process.env.MAIL_TRANSPORT = "memory";
  process.env.INTERNAL_SERVICE_TOKEN = "z".repeat(40);
  await resetDatabase();
  A = await seedAgency("Identity A");
  app = require("../src/app");
  db = require("../src/db");
  mailer = require("../src/services/mailer").getMailer();
});
afterAll(closeDb);

const tokenFrom = (mail) => decodeURIComponent(mail.text.match(/token=([^\s]+)/)[1]);
const lastMail = () => mailer.outbox[mailer.outbox.length - 1];
const bearer = (t) => ({ Authorization: `Bearer ${t}` });

async function signupAndLogin(email, { verify = true, first = "Ada", last = "Obi" } = {}) {
  const s = await request(app).post("/v1/account/signup").send({ email, password: PW, firstName: first, lastName: last });
  expect(s.status).toBe(202);
  if (verify) expect((await request(app).post("/v1/account/verify-email").send({ token: tokenFrom(lastMail()) })).status).toBe(200);
  const l = await request(app).post("/v1/account/login").send({ email, password: PW });
  expect(l.status).toBe(200);
  return l.body;
}
async function inviteAndLogin(email, role) {
  const inv = await request(app).post("/v1/staff").set(bearer(A.apiKey)).send({ email, fullName: "Sam Staff", role });
  expect(inv.status).toBe(201);
  const set = await request(app).post("/v1/account/password-reset/confirm").send({ token: tokenFrom(lastMail()), password: PW });
  expect(set.status).toBe(200);
  return (await request(app).post("/v1/account/login").send({ email, password: PW })).body;
}
async function seedOffer(agencyId, kind = "flight", price = 500) {
  const s = await db.query(`INSERT INTO searches (agency_id, type, criteria, status) VALUES ($1,$2,'{}','completed') RETURNING id`, [agencyId, kind]);
  const o = await db.query(`INSERT INTO offers (search_id, agency_id, type, supplier_code, supplier_offer_ref, price, currency, payload, expires_at)
     VALUES ($1,$2,$3,'letsfg',$4,$5,'USD','{"airline":"BA"}', now() + interval '1 hour') RETURNING id`, [s.rows[0].id, agencyId, kind, `${OFFER_FLIGHT_REF}-${Math.random()}`, price]);
  return o.rows[0].id;
}

test("direct sign-up creates a house-agency traveller; the password is stored hashed; the verify link works once", async () => {
  const body = await signupAndLogin("ada1@example.com", { verify: false });
  expect(body.principal.role).toBe("traveller");
  expect(body.principal.agencyKind).toBe("house");
  expect(body.principal.emailVerified).toBe(false);
  const u = (await db.query(`SELECT password_hash FROM users WHERE email='ada1@example.com'`)).rows[0];
  expect(u.password_hash).toMatch(/^scrypt\$/);
  expect(JSON.stringify(u)).not.toContain(PW);
  const token = tokenFrom(lastMail());
  expect((await request(app).post("/v1/account/verify-email").send({ token })).status).toBe(200);
  expect((await request(app).post("/v1/account/verify-email").send({ token })).status).toBe(400);
  const me = await request(app).get("/v1/account/me").set(bearer(body.token));
  expect(me.body.emailVerified).toBe(true);
});

test("sign-up with an existing email answers the same and creates nothing; wrong password and unknown email look identical", async () => {
  await signupAndLogin("dup@example.com");
  const before = (await db.query(`SELECT COUNT(*)::int n FROM users`)).rows[0].n;
  const again = await request(app).post("/v1/account/signup").send({ email: "DUP@example.com", password: PW, firstName: "X", lastName: "Y" });
  expect(again.status).toBe(202);
  expect((await db.query(`SELECT COUNT(*)::int n FROM users`)).rows[0].n).toBe(before);
  const a = await request(app).post("/v1/account/login").send({ email: "dup@example.com", password: "wrong-password-1" });
  const b = await request(app).post("/v1/account/login").send({ email: "nobody@example.com", password: "wrong-password-1" });
  expect(a.status).toBe(401); expect(b.status).toBe(401);
  expect(a.body).toEqual(b.body);
});

test("a traveller session can plan and see only their own trips; another traveller gets 404", async () => {
  const t1 = await signupAndLogin("one@example.com"); const t2 = await signupAndLogin("two@example.com", { first: "Bola", last: "Ade" });
  const trip = await request(app).post("/v1/trips").set(bearer(t1.token)).send({ title: "Mine", travelerId: t2.principal.travelerId });
  expect(trip.status).toBe(201);
  expect(trip.body.traveler_id).toBe(t1.principal.travelerId);               // body travelerId is ignored for travellers
  expect((await request(app).get(`/v1/trips/${trip.body.id}`).set(bearer(t2.token))).status).toBe(404);
  expect((await request(app).get("/v1/trips").set(bearer(t2.token))).body.trips).toHaveLength(0);
  expect((await request(app).get("/v1/trips").set(bearer(t1.token))).body.trips).toHaveLength(1);
  expect((await request(app).patch(`/v1/trips/${trip.body.id}`).set(bearer(t2.token)).send({ title: "hijack" })).status).toBe(404);
});

test("traveller sessions cannot reach raw booking, order, staff or key endpoints", async () => {
  const t = await signupAndLogin("blocked@example.com");
  for (const [m, url] of [["post", "/v1/flights/bookings"], ["post", "/v1/hotels/bookings"], ["get", "/v1/orders"], ["get", "/v1/staff"], ["post", "/v1/auth/api-keys"], ["post", "/v1/travelers"]]) {
    expect((await request(app)[m](url).set(bearer(t.token)).send({})).status).toBe(403);
  }
});

test("unverified travellers can plan but cannot approve; verified travellers can, and the approver is recorded", async () => {
  const t = await signupAndLogin("unver@example.com", { verify: false });
  const trip = (await request(app).post("/v1/trips").set(bearer(t.token)).send({ title: "T" })).body;
  const offerId = await seedOffer(t.principal.agencyId);
  const add = await request(app).post(`/v1/trips/${trip.id}/items`).set(bearer(t.token)).send({ kind: "flight", offerId });
  expect(add.status).toBe(201);
  const body = { confirm: true, acknowledgedPrice: 500, currency: "USD" };
  const blocked = await request(app).post(`/v1/trips/${trip.id}/items/${add.body.id}/approve`).set(bearer(t.token)).send(body);
  expect(blocked.status).toBe(403); expect(blocked.body.code).toBe("EMAIL_NOT_VERIFIED");
  await request(app).post("/v1/account/resend-verification").set(bearer(t.token));
  await request(app).post("/v1/account/verify-email").send({ token: tokenFrom(lastMail()) });
  const ok = await request(app).post(`/v1/trips/${trip.id}/items/${add.body.id}/approve`).set(bearer(t.token)).send(body);
  expect(ok.status).toBe(201);
  const row = (await db.query(`SELECT approved_by_user_id, approved_by_role, consent_attested FROM agent_trip_approvals WHERE id=$1`, [ok.body.approvalId])).rows[0];
  expect(row.approved_by_user_id).toBe(t.principal.userId); expect(row.approved_by_role).toBe("traveller"); expect(row.consent_attested).toBe(false);
});

test("agency self-booking policy: when off, a traveller cannot approve and is told their agent will book", async () => {
  const t = await signupAndLogin("policy@example.com");
  await db.query(`UPDATE agencies SET traveller_self_booking=false WHERE kind='house'`);
  try {
    const trip = (await request(app).post("/v1/trips").set(bearer(t.token)).send({ title: "T" })).body;
    const offerId = await seedOffer(t.principal.agencyId);
    const item = (await request(app).post(`/v1/trips/${trip.id}/items`).set(bearer(t.token)).send({ kind: "flight", offerId })).body;
    const r = await request(app).post(`/v1/trips/${trip.id}/items/${item.id}/approve`).set(bearer(t.token)).send({ confirm: true, acknowledgedPrice: 500, currency: "USD" });
    expect(r.status).toBe(403); expect(r.body.code).toBe("SELF_BOOKING_DISABLED");
  } finally { await db.query(`UPDATE agencies SET traveller_self_booking=true WHERE kind='house'`); }
});

test("agency staff: invite -> set password -> sign in; agents act for any client but must attest consent; only admins manage staff and keys", async () => {
  const agent = await inviteAndLogin("agent@acme.test", "agent");
  expect(agent.principal.role).toBe("agent"); expect(agent.principal.emailVerified).toBe(true);
  expect((await request(app).get("/v1/staff").set(bearer(agent.token))).status).toBe(403);
  expect((await request(app).post("/v1/auth/api-keys").set(bearer(agent.token)).send({ label: "x" })).status).toBe(403);
  const list = await request(app).get("/v1/staff").set(bearer(A.apiKey));
  expect(list.body.staff.map((s) => s.email)).toContain("agent@acme.test");

  const client = await request(app).post("/v1/travelers").set(bearer(agent.token)).send({ firstName: "Chi", lastName: "Eze", email: "chi@example.com", passportNumber: "B7654321", nationality: "ng", dateOfBirth: "1985-05-05" });
  expect(client.status).toBe(201); expect(client.body.passportMasked).not.toContain("B7654321"); expect(client.body.missingForFlights).toEqual([]);
  const trip = (await request(app).post("/v1/trips").set(bearer(agent.token)).send({ title: "For Chi", travelerId: client.body.id })).body;
  const offerId = await seedOffer(A.agencyId);
  const item = (await request(app).post(`/v1/trips/${trip.id}/items`).set(bearer(agent.token)).send({ kind: "flight", offerId })).body;
  const url = `/v1/trips/${trip.id}/items/${item.id}/approve`; const body = { confirm: true, acknowledgedPrice: 500, currency: "USD" };
  const noConsent = await request(app).post(url).set(bearer(agent.token)).send(body);
  expect(noConsent.status).toBe(400); expect(JSON.stringify(noConsent.body)).toMatch(/consent/i);
  const ok = await request(app).post(url).set(bearer(agent.token)).send({ ...body, clientConsent: true });
  expect(ok.status).toBe(201);
  const row = (await db.query(`SELECT approved_by_role, consent_attested FROM agent_trip_approvals WHERE id=$1`, [ok.body.approvalId])).rows[0];
  expect(row.approved_by_role).toBe("agent"); expect(row.consent_attested).toBe(true);
});

test("booking is refused with PROFILE_INCOMPLETE (approval untouched) when the traveller lacks passport details", async () => {
  const t = await signupAndLogin("incomplete@example.com");
  const trip = (await request(app).post("/v1/trips").set(bearer(t.token)).send({ title: "T" })).body;
  const offerId = await seedOffer(t.principal.agencyId);
  const item = (await request(app).post(`/v1/trips/${trip.id}/items`).set(bearer(t.token)).send({ kind: "flight", offerId })).body;
  const ap = (await request(app).post(`/v1/trips/${trip.id}/items/${item.id}/approve`).set(bearer(t.token)).send({ confirm: true, acknowledgedPrice: 500, currency: "USD" })).body;
  const r = await request(app).post(`/v1/trips/${trip.id}/items/${item.id}/book`).set(bearer(t.token)).set("Idempotency-Key", "k-incomplete").send({ approvalId: ap.approvalId });
  expect(r.status).toBe(400); expect(r.body.code).toBe("PROFILE_INCOMPLETE"); expect(r.body.missing).toEqual(["dateOfBirth", "passportNumber", "nationality"]);
  expect((await db.query(`SELECT status FROM agent_trip_approvals WHERE id=$1`, [ap.approvalId])).rows[0].status).toBe("active");
  const patched = await request(app).patch("/v1/travelers/me").set(bearer(t.token)).send({ dateOfBirth: "1990-01-02", passportNumber: "a1234567", nationality: "ng" });
  expect(patched.status).toBe(200); expect(patched.body.missingForFlights).toEqual([]); expect(patched.body.passportMasked).not.toContain("A1234567");
});

test("password reset: the link works once and signs out every existing session", async () => {
  const t = await signupAndLogin("reset@example.com");
  expect((await request(app).post("/v1/account/password-reset/request").send({ email: "reset@example.com" })).status).toBe(202);
  const token = tokenFrom(lastMail());
  const set = await request(app).post("/v1/account/password-reset/confirm").send({ token, password: "a brand new passphrase" });
  expect(set.status).toBe(200);
  expect((await request(app).get("/v1/account/me").set(bearer(t.token))).status).toBe(401);
  expect((await request(app).post("/v1/account/password-reset/confirm").send({ token, password: "another passphrase here" })).status).toBe(400);
  expect((await request(app).post("/v1/account/login").send({ email: "reset@example.com", password: "a brand new passphrase" })).status).toBe(200);
});

test("logout ends the session; a disabled staff member loses access immediately; an agency cannot lose its last admin", async () => {
  const t = await signupAndLogin("bye@example.com");
  expect((await request(app).post("/v1/account/logout").set(bearer(t.token))).status).toBe(200);
  expect((await request(app).get("/v1/trips").set(bearer(t.token))).status).toBe(401);
  const staff = await inviteAndLogin("temp@acme.test", "agent");
  const row = (await request(app).get("/v1/staff").set(bearer(A.apiKey))).body.staff.find((s) => s.email === "temp@acme.test");
  expect((await request(app).patch(`/v1/staff/${row.membershipId}`).set(bearer(A.apiKey)).send({ status: "disabled" })).status).toBe(200);
  expect((await request(app).get("/v1/trips").set(bearer(staff.token))).status).toBe(401);
  const admin = await inviteAndLogin("boss@acme.test", "admin");
  const mine = (await request(app).get("/v1/staff").set(bearer(admin.token))).body.staff.find((s) => s.email === "boss@acme.test");
  // boss is the ONLY admin membership, so disabling them is refused...
  const refused = await request(app).patch(`/v1/staff/${mine.membershipId}`).set(bearer(A.apiKey)).send({ status: "disabled" });
  expect(refused.status).toBe(400); expect(JSON.stringify(refused.body)).toMatch(/at least one active admin/);
  // ...but once a second admin exists, it is allowed.
  await inviteAndLogin("boss2@acme.test", "admin");
  expect((await request(app).patch(`/v1/staff/${mine.membershipId}`).set(bearer(A.apiKey)).send({ status: "disabled" })).status).toBe(200);
});

test("tenant isolation still holds for sessions: staff of agency B cannot see agency A's trips", async () => {
  const B = await seedAgency("Identity B");
  const trip = (await request(app).post("/v1/trips").set(bearer(A.apiKey)).send({ title: "A only" })).body;
  const inv = await request(app).post("/v1/staff").set(bearer(B.apiKey)).send({ email: "bstaff@b.test", fullName: "B Staff", role: "agent" });
  expect(inv.status).toBe(201);
  await request(app).post("/v1/account/password-reset/confirm").send({ token: tokenFrom(lastMail()), password: PW });
  const login = (await request(app).post("/v1/account/login").send({ email: "bstaff@b.test", password: PW })).body;
  expect((await request(app).get(`/v1/trips/${trip.id}`).set(bearer(login.token))).status).toBe(404);
});
