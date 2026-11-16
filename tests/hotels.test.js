// Integration tests for Sprint 2 (hotels), mirroring tests/flights.test.js.
// Run: TEST_DATABASE_URL=postgres://... LETSFG_API_KEY=test-key npm test
const request = require("supertest");
const { resetDatabase, seedAgency, closeDb } = require("./setup");

let app;
let agencyA;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  process.env.LETSFG_AUTH_MODE = "developer";
  process.env.LETSFG_API_KEY = "test-key"; // required for hotelRegistry to construct the adapter at all
  process.env.LETSFG_BEARER_TOKEN = "test-token"; // flight adapter still needs this if authMode stays pfs there; harmless if unused
  await resetDatabase();
  agencyA = await seedAgency("Hotel Test Agency");
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
  destination: "Lagos",
  checkIn: "2026-12-01",
  checkOut: "2026-12-05",
  guests: { adults: 2 },
};

const oneHotelOffer = {
  status: "completed",
  offers: [
    {
      offer_id: "sup_hotel_off_1",
      hotel_name: "Eko Hotel",
      price: 300,
      currency: "USD",
      check_in: "2026-12-01",
      check_out: "2026-12-05",
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    },
  ],
};

async function createFreshHotelOffer(apiKey, tag) {
  fakeFetch({
    "/hotels/search/async": { search_id: `sup_hsearch_${tag}` },
    "/hotels/search/": {
      status: "completed",
      offers: [{ offer_id: `sup_hotel_off_${tag}`, hotel_name: "Eko Hotel", price: 300, currency: "USD", expires_at: new Date(Date.now() + 3600_000).toISOString() }],
    },
  });
  const search = await request(app).post("/v1/hotels/search").set("Authorization", `Bearer ${apiKey}`).send(validSearchBody);
  const polled = await request(app).get(`/v1/hotels/search/${search.body.searchId}`).set("Authorization", `Bearer ${apiKey}`);
  return polled.body.offers[0].offerId;
}

describe("Hotel search -> offer persistence", () => {
  let searchId;

  test("search accepted", async () => {
    fakeFetch({ "/hotels/search/async": { search_id: "sup_hsearch_1" } });
    const res = await request(app)
      .post("/v1/hotels/search")
      .set("Authorization", `Bearer ${agencyA.apiKey}`)
      .send(validSearchBody);
    expect(res.status).toBe(202);
    searchId = res.body.searchId;
  });

  test("checkOut before checkIn is rejected by validation", async () => {
    const res = await request(app)
      .post("/v1/hotels/search")
      .set("Authorization", `Bearer ${agencyA.apiKey}`)
      .send({ ...validSearchBody, checkIn: "2026-12-05", checkOut: "2026-12-01" });
    expect(res.status).toBe(400);
  });

  test("poll returns persisted hotel offers, correctly typed (offers table shared with flights)", async () => {
    fakeFetch({ "/hotels/search/": oneHotelOffer });
    const res = await request(app)
      .get(`/v1/hotels/search/${searchId}`)
      .set("Authorization", `Bearer ${agencyA.apiKey}`);
    expect(res.body.status).toBe("completed");
    expect(res.body.offers[0].hotelName).toBe("Eko Hotel");
  });
});

describe("Hotel booking — async job lifecycle (T-055)", () => {
  const guests = [{ firstName: "A", lastName: "B" }];
  const contact = { email: "a@b.com" };

  test("POST /bookings returns 202 pending, never a synchronous confirmation", async () => {
    const offerId = await createFreshHotelOffer(agencyA.apiKey, "book1");
    fakeFetch({ "/hotels/bookings": { booking_job_id: "job_abc123" } });
    const res = await request(app)
      .post("/v1/hotels/bookings")
      .set("Authorization", `Bearer ${agencyA.apiKey}`)
      .set("Idempotency-Key", "hbook-1")
      .send({ offerId, guests, contact });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("pending");
    expect(res.body.confirmationNumber).toBeNull();
  });

  test("polling a succeeded job surfaces confirmationNumber, payLink, balanceDueBy (T-057)", async () => {
    const offerId = await createFreshHotelOffer(agencyA.apiKey, "book2");
    fakeFetch({ "/hotels/bookings": { booking_job_id: "job_def456" } });
    const created = await request(app)
      .post("/v1/hotels/bookings")
      .set("Authorization", `Bearer ${agencyA.apiKey}`)
      .set("Idempotency-Key", "hbook-2")
      .send({ offerId, guests, contact });

    fakeFetch({
      "/hotels/booking/job_def456": {
        status: "succeeded",
        confirmation_number: "CONF999",
        pay_link: "https://pay.example/xyz",
        balance_due_by: "2026-11-20T00:00:00Z",
        reservation_fee_amount: 15,
        cancellation_terms: { free_until: "2026-11-20T00:00:00Z" },
      },
    });
    const polled = await request(app)
      .get(`/v1/hotels/bookings/${created.body.bookingId}`)
      .set("Authorization", `Bearer ${agencyA.apiKey}`);

    expect(polled.body.status).toBe("confirmed");
    expect(polled.body.confirmationNumber).toBe("CONF999");
    expect(polled.body.payLink).toBe("https://pay.example/xyz");
    expect(polled.body.balanceDueBy).toBeTruthy();
    expect(polled.body.reservationFeeStatus).toBe("charged");
  });

  test("polling a failed job marks the booking failed, not stuck pending forever", async () => {
    const offerId = await createFreshHotelOffer(agencyA.apiKey, "book3");
    fakeFetch({ "/hotels/bookings": { booking_job_id: "job_fail1" } });
    const created = await request(app)
      .post("/v1/hotels/bookings")
      .set("Authorization", `Bearer ${agencyA.apiKey}`)
      .set("Idempotency-Key", "hbook-3")
      .send({ offerId, guests, contact });

    fakeFetch({ "/hotels/booking/job_fail1": { status: "failed" } });
    const polled = await request(app)
      .get(`/v1/hotels/bookings/${created.body.bookingId}`)
      .set("Authorization", `Bearer ${agencyA.apiKey}`);
    expect(polled.body.status).toBe("failed");
  });

  test("still-processing job leaves booking pending (no premature confirmation)", async () => {
    const offerId = await createFreshHotelOffer(agencyA.apiKey, "book4");
    fakeFetch({ "/hotels/bookings": { booking_job_id: "job_proc1" } });
    const created = await request(app)
      .post("/v1/hotels/bookings")
      .set("Authorization", `Bearer ${agencyA.apiKey}`)
      .set("Idempotency-Key", "hbook-4")
      .send({ offerId, guests, contact });

    fakeFetch({ "/hotels/booking/job_proc1": { status: "processing" } });
    const polled = await request(app)
      .get(`/v1/hotels/bookings/${created.body.bookingId}`)
      .set("Authorization", `Bearer ${agencyA.apiKey}`);
    expect(polled.body.status).toBe("pending");
  });
});

describe("Hotel booking idempotency (never double-book/double-charge)", () => {
  test("same key returns the same booking job, does not call supplier.book() again", async () => {
    const offerId = await createFreshHotelOffer(agencyA.apiKey, "hidem1");
    fakeFetch({ "/hotels/bookings": { booking_job_id: "job_idem1" } });
    const first = await request(app)
      .post("/v1/hotels/bookings")
      .set("Authorization", `Bearer ${agencyA.apiKey}`)
      .set("Idempotency-Key", "hotel-shared-key-1")
      .send({ offerId, guests: [{ firstName: "A", lastName: "B" }], contact: { email: "a@b.com" } });

    // If this second call reached supplier.book() again it would try to POST
    // /hotels/bookings and fail (unmocked), proving no double-booking call happened.
    global.fetch = jest.fn(() => { throw new Error("should not call supplier.book() again"); });
    const second = await request(app)
      .post("/v1/hotels/bookings")
      .set("Authorization", `Bearer ${agencyA.apiKey}`)
      .set("Idempotency-Key", "hotel-shared-key-1")
      .send({ offerId, guests: [{ firstName: "A", lastName: "B" }], contact: { email: "a@b.com" } });

    expect(second.status).toBe(200);
    expect(second.body.bookingId).toBe(first.body.bookingId);
  });
});

describe("Hotel cancellation (T-056)", () => {
  test("cannot cancel a booking that isn't confirmed yet", async () => {
    const offerId = await createFreshHotelOffer(agencyA.apiKey, "cancel1");
    fakeFetch({ "/hotels/bookings": { booking_job_id: "job_cancel1" } });
    const created = await request(app)
      .post("/v1/hotels/bookings")
      .set("Authorization", `Bearer ${agencyA.apiKey}`)
      .set("Idempotency-Key", "hcancel-1")
      .send({ offerId, guests: [{ firstName: "A", lastName: "B" }], contact: { email: "a@b.com" } });

    const res = await request(app)
      .post(`/v1/hotels/bookings/${created.body.bookingId}/cancel`)
      .set("Authorization", `Bearer ${agencyA.apiKey}`);
    expect(res.status).toBe(400);
  });

  test("simulate=true previews the refund without changing booking status", async () => {
    const offerId = await createFreshHotelOffer(agencyA.apiKey, "cancel2");
    fakeFetch({ "/hotels/bookings": { booking_job_id: "job_cancel2" } });
    const created = await request(app)
      .post("/v1/hotels/bookings")
      .set("Authorization", `Bearer ${agencyA.apiKey}`)
      .set("Idempotency-Key", "hcancel-2")
      .send({ offerId, guests: [{ firstName: "A", lastName: "B" }], contact: { email: "a@b.com" } });

    fakeFetch({ "/hotels/booking/job_cancel2": { status: "succeeded", confirmation_number: "CONF_C2" } });
    await request(app).get(`/v1/hotels/bookings/${created.body.bookingId}`).set("Authorization", `Bearer ${agencyA.apiKey}`);

    fakeFetch({ "/cancel?simulate=true": { status: "would_cancel", refund_amount: 285 } });
    const res = await request(app)
      .post(`/v1/hotels/bookings/${created.body.bookingId}/cancel?simulate=true`)
      .set("Authorization", `Bearer ${agencyA.apiKey}`);
    expect(res.status).toBe(200);
    expect(res.body.simulate).toBe(true);
    expect(res.body.refundAmount).toBe(285);

    const stillConfirmed = await request(app)
      .get(`/v1/hotels/bookings/${created.body.bookingId}`)
      .set("Authorization", `Bearer ${agencyA.apiKey}`);
    expect(stillConfirmed.body.status).toBe("confirmed"); // simulate must not have cancelled it
  });
});
