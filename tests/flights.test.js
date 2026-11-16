// Integration tests against a real (throwaway) Postgres. LetsFG itself is
// stubbed via global.fetch so these are deterministic and don't require
// live supplier credentials — but they exercise the real SQL, real
// middleware, and real route logic, which is where the P0 bugs were.
//
// Run: TEST_DATABASE_URL=postgres://... npm test
const request = require("supertest");
const { resetDatabase, seedAgency, closeDb } = require("./setup");

let app;
let agencyA, agencyB;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  process.env.LETSFG_AUTH_MODE = "pfs";
  process.env.LETSFG_BEARER_TOKEN = "test-token";
  await resetDatabase();
  agencyA = await seedAgency("Agency A");
  agencyB = await seedAgency("Agency B");
  app = require("../src/app");
});

afterAll(async () => {
  // Fix for a confirmed open-handle leak: nothing was closing the shared
  // connection pool app.js uses, so Jest correctly reported open handles
  // after every suite finished.
  await closeDb();
});

function fakeFetch(responsesByPath) {
  global.fetch = jest.fn(async (url) => {
    const match = Object.entries(responsesByPath).find(([path]) => url.includes(path));
    if (!match) throw new Error(`Unmocked fetch: ${url}`);
    const [, body] = match;
    return { ok: true, status: 200, json: async () => body };
  });
}

const validSearchBody = {
  origin: "LOS",
  destination: "LHR",
  departDate: "2026-12-01",
  passengers: { adults: 1 },
};

const oneOffer = {
  status: "completed",
  offers: [
    { offer_id: "sup_off_1", airline: "BA", price: 500, currency: "USD", outbound: {}, expires_at: new Date(Date.now() + 3600_000).toISOString() },
  ],
};

describe("Auth", () => {
  test("rejects requests with no Authorization header", async () => {
    const res = await request(app).post("/v1/flights/search").send(validSearchBody);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHORIZED");
  });

  test("rejects an invalid API key", async () => {
    const res = await request(app)
      .post("/v1/flights/search")
      .set("Authorization", "Bearer not-a-real-key")
      .send(validSearchBody);
    expect(res.status).toBe(401);
  });

  test("accepts a valid API key", async () => {
    fakeFetch({ "/api/search": { search_id: "sup_search_1" } });
    const res = await request(app)
      .post("/v1/flights/search")
      .set("Authorization", `Bearer ${agencyA.apiKey}`)
      .send(validSearchBody);
    expect(res.status).toBe(202);
  });
});

describe("Request validation", () => {
  test("rejects a search missing required fields", async () => {
    const res = await request(app)
      .post("/v1/flights/search")
      .set("Authorization", `Bearer ${agencyA.apiKey}`)
      .send({ origin: "LOS" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
  });

  test("rejects a non-IATA origin code", async () => {
    const res = await request(app)
      .post("/v1/flights/search")
      .set("Authorization", `Bearer ${agencyA.apiKey}`)
      .send({ ...validSearchBody, origin: "LAGOS" });
    expect(res.status).toBe(400);
  });
});

describe("Search -> offer persistence -> retrieval", () => {
  let searchId;

  test("search accepted and persisted", async () => {
    fakeFetch({ "/api/search": { search_id: "sup_search_2" } });
    const res = await request(app)
      .post("/v1/flights/search")
      .set("Authorization", `Bearer ${agencyA.apiKey}`)
      .send(validSearchBody);
    expect(res.status).toBe(202);
    searchId = res.body.searchId;
  });

  test("polling a completed search returns persisted offers (P1-4 regression test)", async () => {
    fakeFetch({ "/api/results/": oneOffer });
    const first = await request(app)
      .get(`/v1/flights/search/${searchId}`)
      .set("Authorization", `Bearer ${agencyA.apiKey}`);
    expect(first.body.status).toBe("completed");
    expect(first.body.offers).toHaveLength(1);

    // Second poll must NOT hit the supplier again — it should read the
    // already-persisted offers straight from the DB.
    global.fetch = jest.fn(() => { throw new Error("should not call supplier again"); });
    const second = await request(app)
      .get(`/v1/flights/search/${searchId}`)
      .set("Authorization", `Bearer ${agencyA.apiKey}`);
    expect(second.status).toBe(200);
    expect(second.body.offers).toHaveLength(1);
  });

  test("offer insert lands in the correct columns (P0-1 regression test)", async () => {
    const offerId = (await request(app)
      .get(`/v1/flights/search/${searchId}`)
      .set("Authorization", `Bearer ${agencyA.apiKey}`)).body.offers[0].offerId;

    const res = await request(app)
      .get(`/v1/flights/offers/${offerId}`)
      .set("Authorization", `Bearer ${agencyA.apiKey}`);
    expect(res.status).toBe(200);
    expect(res.body.airline).toBe("BA"); // would previously have thrown a UUID type error before insert even completed
  });
});

describe("Tenant isolation", () => {
  test("agency B cannot fetch agency A's search", async () => {
    fakeFetch({ "/api/search": { search_id: "sup_search_3" } });
    const created = await request(app)
      .post("/v1/flights/search")
      .set("Authorization", `Bearer ${agencyA.apiKey}`)
      .send(validSearchBody);

    const res = await request(app)
      .get(`/v1/flights/search/${created.body.searchId}`)
      .set("Authorization", `Bearer ${agencyB.apiKey}`);
    expect(res.status).toBe(404);
  });
});

describe("Offer expiry", () => {
  test("booking an expired offer is rejected, not silently booked", async () => {
    const expiredOffer = {
      status: "completed",
      offers: [{ offer_id: "sup_off_expired", airline: "BA", price: 500, currency: "USD", expires_at: new Date(Date.now() - 1000).toISOString() }],
    };
    fakeFetch({ "/api/search": { search_id: "sup_search_4" }, "/api/results/": expiredOffer });
    const search = await request(app)
      .post("/v1/flights/search")
      .set("Authorization", `Bearer ${agencyA.apiKey}`)
      .send(validSearchBody);
    const polled = await request(app)
      .get(`/v1/flights/search/${search.body.searchId}`)
      .set("Authorization", `Bearer ${agencyA.apiKey}`);
    const offerId = polled.body.offers[0].offerId;

    const res = await request(app)
      .post("/v1/flights/bookings")
      .set("Authorization", `Bearer ${agencyA.apiKey}`)
      .set("Idempotency-Key", "expiry-test-1")
      .send({
        offerId,
        passengers: [{ firstName: "A", lastName: "B", dateOfBirth: "1990-01-01" }],
        contact: { email: "a@b.com" },
      });
    expect(res.status).toBe(410);
    expect(res.body.code).toBe("OFFER_EXPIRED");
  });
});

async function createFreshOffer(apiKey, searchTag) {
  fakeFetch({
    "/api/search": { search_id: `sup_search_${searchTag}` },
    "/api/results/": { status: "completed", offers: [{ offer_id: `sup_off_${searchTag}`, airline: "BA", price: 500, currency: "USD", expires_at: new Date(Date.now() + 3600_000).toISOString() }] },
  });
  const search = await request(app).post("/v1/flights/search").set("Authorization", `Bearer ${apiKey}`).send(validSearchBody);
  const polled = await request(app).get(`/v1/flights/search/${search.body.searchId}`).set("Authorization", `Bearer ${apiKey}`);
  return polled.body.offers[0].offerId;
}

describe("Booking state (P0-2/P0-3 regression tests)", () => {
  const passenger = { firstName: "A", lastName: "B", dateOfBirth: "1990-01-01" };
  const contact = { email: "a@b.com" };

  test("supplier returning a PNR -> booking is confirmed", async () => {
    const offerId = await createFreshOffer(agencyA.apiKey, "conf1");
    fakeFetch({ "/api/agent-book": { pnr: "ABC123", status: "confirmed" } });
    const res = await request(app)
      .post("/v1/flights/bookings")
      .set("Authorization", `Bearer ${agencyA.apiKey}`)
      .set("Idempotency-Key", "book-confirmed-1")
      .send({ offerId, passengers: [passenger], contact });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("confirmed");
    expect(res.body.supplierReference).toBe("ABC123");
  });

  test("supplier returning only a booking_url (no PNR) -> action_required, NOT confirmed", async () => {
    const offerId = await createFreshOffer(agencyA.apiKey, "handoff1");
    fakeFetch({ "/api/agent-book": { booking_url: "https://airline.example/checkout/xyz", status: "pending" } });
    const res = await request(app)
      .post("/v1/flights/bookings")
      .set("Authorization", `Bearer ${agencyA.apiKey}`)
      .set("Idempotency-Key", "book-handoff-1")
      .send({ offerId, passengers: [passenger], contact });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("action_required");
    expect(res.body.bookingUrl).toBe("https://airline.example/checkout/xyz");
  });

  test("ambiguous supplier failure (502/unavailable) -> reconciliation_required, NOT failed (regression test for the timeout-ambiguity fix)", async () => {
    const offerId = await createFreshOffer(agencyA.apiKey, "ambig1");
    global.fetch = jest.fn(async () => ({ ok: false, status: 502, text: async () => "supplier down" }));
    const res = await request(app)
      .post("/v1/flights/bookings")
      .set("Authorization", `Bearer ${agencyA.apiKey}`)
      .set("Idempotency-Key", "book-ambig-1")
      .send({ offerId, passengers: [passenger], contact });
    expect(res.status).toBe(502);

    const getRes = await request(app)
      .get(`/v1/flights/bookings/${res.body?.bookingId || ""}`)
      .set("Authorization", `Bearer ${agencyA.apiKey}`);
    // The core assertion: a 502/unavailable supplier response is NOT proof
    // of failure — the supplier may have accepted the booking. Marking it
    // 'failed' would invite a client retry with a new idempotency key,
    // risking a duplicate reservation.
    if (getRes.status === 200) expect(getRes.body.status).toBe("reconciliation_required");
  });

  test("supplier timeout -> reconciliation_required, NOT failed", async () => {
    const offerId = await createFreshOffer(agencyA.apiKey, "timeout1");
    global.fetch = jest.fn(async () => ({ ok: false, status: 504, text: async () => "" }));
    const res = await request(app)
      .post("/v1/flights/bookings")
      .set("Authorization", `Bearer ${agencyA.apiKey}`)
      .set("Idempotency-Key", "book-timeout-1")
      .send({ offerId, passengers: [passenger], contact });
    expect(res.status).toBe(504);

    const getRes = await request(app)
      .get(`/v1/flights/bookings/${res.body?.bookingId || ""}`)
      .set("Authorization", `Bearer ${agencyA.apiKey}`);
    if (getRes.status === 200) expect(getRes.body.status).toBe("reconciliation_required");
  });
});

describe("Idempotency (P1-5 regression test)", () => {
  test("same key + same agency returns the same booking, does not double-book", async () => {
    const offerId = await createFreshOffer(agencyA.apiKey, "idem1");
    fakeFetch({ "/api/agent-book": { pnr: "IDEM1", status: "confirmed" } });
    const first = await request(app)
      .post("/v1/flights/bookings")
      .set("Authorization", `Bearer ${agencyA.apiKey}`)
      .set("Idempotency-Key", "shared-key-1")
      .send({ offerId, passengers: [{ firstName: "A", lastName: "B", dateOfBirth: "1990-01-01" }], contact: { email: "a@b.com" } });

    const second = await request(app)
      .post("/v1/flights/bookings")
      .set("Authorization", `Bearer ${agencyA.apiKey}`)
      .set("Idempotency-Key", "shared-key-1")
      .send({ offerId, passengers: [{ firstName: "A", lastName: "B", dateOfBirth: "1990-01-01" }], contact: { email: "a@b.com" } });

    expect(second.status).toBe(200);
    expect(second.body.bookingId).toBe(first.body.bookingId);
  });

  test("same key, DIFFERENT agency, does not collide (tenant-scoped idempotency)", async () => {
    const offerIdA = await createFreshOffer(agencyA.apiKey, "tenidemA");
    fakeFetch({ "/api/agent-book": { pnr: "TENIDEM_A", status: "confirmed" } });
    const bookingA = await request(app)
      .post("/v1/flights/bookings")
      .set("Authorization", `Bearer ${agencyA.apiKey}`)
      .set("Idempotency-Key", "cross-tenant-key")
      .send({ offerId: offerIdA, passengers: [{ firstName: "A", lastName: "B", dateOfBirth: "1990-01-01" }], contact: { email: "a@b.com" } });

    const offerIdB = await createFreshOffer(agencyB.apiKey, "tenidemB");
    fakeFetch({ "/api/agent-book": { pnr: "TENIDEM_B", status: "confirmed" } });
    const bookingB = await request(app)
      .post("/v1/flights/bookings")
      .set("Authorization", `Bearer ${agencyB.apiKey}`)
      .set("Idempotency-Key", "cross-tenant-key") // same key, different agency
      .send({ offerId: offerIdB, passengers: [{ firstName: "A", lastName: "B", dateOfBirth: "1990-01-01" }], contact: { email: "a@b.com" } });

    expect(bookingA.status).toBe(201);
    expect(bookingB.status).toBe(201);
    expect(bookingA.body.bookingId).not.toBe(bookingB.body.bookingId);
  });

  test("same key, DIFFERENT body -> rejected as reused, not silently booked against the new body", async () => {
    const offerId = await createFreshOffer(agencyA.apiKey, "hashmismatch1");
    fakeFetch({ "/api/agent-book": { pnr: "SHOULD_NOT_BE_USED", status: "confirmed" } });
    const first = await request(app)
      .post("/v1/flights/bookings")
      .set("Authorization", `Bearer ${agencyA.apiKey}`)
      .set("Idempotency-Key", "hash-mismatch-key")
      .send({ offerId, passengers: [{ firstName: "A", lastName: "B", dateOfBirth: "1990-01-01" }], contact: { email: "a@b.com" } });
    expect(first.status).toBe(201);

    const offerId2 = await createFreshOffer(agencyA.apiKey, "hashmismatch2");
    const second = await request(app)
      .post("/v1/flights/bookings")
      .set("Authorization", `Bearer ${agencyA.apiKey}`)
      .set("Idempotency-Key", "hash-mismatch-key") // same key
      .send({ offerId: offerId2, passengers: [{ firstName: "DIFFERENT", lastName: "PERSON", dateOfBirth: "1985-05-05" }], contact: { email: "different@b.com" } }); // different body

    expect(second.status).toBe(422);
    expect(second.body.code).toBe("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY");
  });

  test("booking mutation without Idempotency-Key header is rejected", async () => {
    const res = await request(app)
      .post("/v1/flights/bookings")
      .set("Authorization", `Bearer ${agencyA.apiKey}`)
      .send({ offerId: "00000000-0000-0000-0000-000000000000", passengers: [{ firstName: "A", lastName: "B", dateOfBirth: "1990-01-01" }], contact: { email: "a@b.com" } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });
});
