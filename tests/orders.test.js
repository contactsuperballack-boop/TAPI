// Integration tests for Sprint 4 (orders & payments). Run:
// TEST_DATABASE_URL=postgres://... npm test
const request = require("supertest");
const crypto = require("crypto");
const { resetDatabase, seedAgency, closeDb } = require("./setup");

let app;
let agencyA;
const WEBHOOK_SECRET = "test-webhook-secret";

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  process.env.LETSFG_AUTH_MODE = "pfs";
  process.env.LETSFG_BEARER_TOKEN = "test-token";
  process.env.MOCK_PAYMENT_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.ORDER_MARKUP_PERCENT = "10";
  process.env.ORDER_SERVICE_FEE_FLAT = "5";
  await resetDatabase();
  agencyA = await seedAgency("Orders Test Agency");
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
    return { ok: true, status: 200, json: async () => match[1] };
  });
}

function signWebhook(bodyObj) {
  const raw = JSON.stringify(bodyObj);
  const signature = crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
  return { raw, signature };
}

async function createConfirmedFlightBooking(apiKey, tag) {
  fakeFetch({
    "/api/search": { search_id: `sup_search_${tag}` },
    "/api/results/": { status: "completed", offers: [{ offer_id: `sup_off_${tag}`, airline: "BA", price: 500, currency: "USD", expires_at: new Date(Date.now() + 3600_000).toISOString() }] },
  });
  const search = await request(app).post("/v1/flights/search").set("Authorization", `Bearer ${apiKey}`).send({ origin: "LOS", destination: "LHR", departDate: "2026-12-01", passengers: { adults: 1 } });
  const polled = await request(app).get(`/v1/flights/search/${search.body.searchId}`).set("Authorization", `Bearer ${apiKey}`);
  const offerId = polled.body.offers[0].offerId;

  fakeFetch({ "/api/agent-book": { pnr: `PNR_${tag}`, status: "confirmed" } });
  const booked = await request(app)
    .post("/v1/flights/bookings")
    .set("Authorization", `Bearer ${apiKey}`)
    .set("Idempotency-Key", `book-${tag}`)
    .send({ offerId, passengers: [{ firstName: "A", lastName: "B", dateOfBirth: "1990-01-01" }], contact: { email: "a@b.com" } });
  return booked.body.bookingId;
}

describe("Order creation (T-070, T-071)", () => {
  test("creates an order from a confirmed booking with correct pricing breakdown", async () => {
    const bookingId = await createConfirmedFlightBooking(agencyA.apiKey, "ord1");
    const res = await request(app)
      .post("/v1/orders")
      .set("Authorization", `Bearer ${agencyA.apiKey}`)
      .set("Idempotency-Key", "order-1")
      .send({ bookingIds: [bookingId] });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("open");
    expect(res.body.supplierCost).toBe(500);
    expect(res.body.markupAmount).toBe(50); // 10% of 500
    expect(res.body.serviceFee).toBe(5);
    expect(res.body.totalPrice).toBe(555);
  });

  test("rejects a booking that isn't confirmed yet", async () => {
    // Create a pending hotel booking (never resolves) and try to order it
    process.env.LETSFG_API_KEY = "test-hotel-key";
    fakeFetch({
      "/hotels/search/async": { search_id: "sup_hsearch_pending" },
      "/hotels/search/": { status: "completed", offers: [{ offer_id: "sup_hotel_pending", hotel_name: "X", price: 100, currency: "USD", expires_at: new Date(Date.now() + 3600_000).toISOString() }] },
    });
    const search = await request(app).post("/v1/hotels/search").set("Authorization", `Bearer ${agencyA.apiKey}`).send({ destination: "Lagos", checkIn: "2026-12-01", checkOut: "2026-12-05", guests: { adults: 1 } });
    const polled = await request(app).get(`/v1/hotels/search/${search.body.searchId}`).set("Authorization", `Bearer ${agencyA.apiKey}`);
    fakeFetch({ "/hotels/bookings": { booking_job_id: "job_pending1" } });
    const booked = await request(app)
      .post("/v1/hotels/bookings")
      .set("Authorization", `Bearer ${agencyA.apiKey}`)
      .set("Idempotency-Key", "hbook-pending1")
      .send({ offerId: polled.body.offers[0].offerId, guests: [{ firstName: "A", lastName: "B" }], contact: { email: "a@b.com" } });
    expect(booked.body.status).toBe("pending");

    const res = await request(app)
      .post("/v1/orders")
      .set("Authorization", `Bearer ${agencyA.apiKey}`)
      .set("Idempotency-Key", "order-reject-pending")
      .send({ bookingIds: [booked.body.bookingId] });
    expect(res.status).toBe(400);
  });

  test("rejects a booking already attached to another order", async () => {
    const bookingId = await createConfirmedFlightBooking(agencyA.apiKey, "ord2");
    await request(app).post("/v1/orders").set("Authorization", `Bearer ${agencyA.apiKey}`).set("Idempotency-Key", "order-2a").send({ bookingIds: [bookingId] });

    const second = await request(app)
      .post("/v1/orders")
      .set("Authorization", `Bearer ${agencyA.apiKey}`)
      .set("Idempotency-Key", "order-2b")
      .send({ bookingIds: [bookingId] });
    expect(second.status).toBe(400);
  });

  test("idempotent order creation returns the same order, doesn't double-create", async () => {
    const bookingId = await createConfirmedFlightBooking(agencyA.apiKey, "ord3");
    const first = await request(app).post("/v1/orders").set("Authorization", `Bearer ${agencyA.apiKey}`).set("Idempotency-Key", "order-3").send({ bookingIds: [bookingId] });
    const second = await request(app).post("/v1/orders").set("Authorization", `Bearer ${agencyA.apiKey}`).set("Idempotency-Key", "order-3").send({ bookingIds: [bookingId] });
    expect(second.status).toBe(200);
    expect(second.body.orderId).toBe(first.body.orderId);
  });
});

describe("Payment initiation (T-072)", () => {
  test("initiating payment returns a checkout URL and pending payment", async () => {
    const bookingId = await createConfirmedFlightBooking(agencyA.apiKey, "pay1");
    const order = await request(app).post("/v1/orders").set("Authorization", `Bearer ${agencyA.apiKey}`).set("Idempotency-Key", "order-pay1").send({ bookingIds: [bookingId] });

    const res = await request(app)
      .post(`/v1/orders/${order.body.orderId}/pay`)
      .set("Authorization", `Bearer ${agencyA.apiKey}`)
      .set("Idempotency-Key", "pay-init-1")
      .send();
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("pending");
    expect(res.body.checkoutUrl).toContain("mock-payments");
  });

  test("idempotent pay initiation does not create a second payment", async () => {
    const bookingId = await createConfirmedFlightBooking(agencyA.apiKey, "pay2");
    const order = await request(app).post("/v1/orders").set("Authorization", `Bearer ${agencyA.apiKey}`).set("Idempotency-Key", "order-pay2").send({ bookingIds: [bookingId] });

    const first = await request(app).post(`/v1/orders/${order.body.orderId}/pay`).set("Authorization", `Bearer ${agencyA.apiKey}`).set("Idempotency-Key", "pay-init-2").send();
    const second = await request(app).post(`/v1/orders/${order.body.orderId}/pay`).set("Authorization", `Bearer ${agencyA.apiKey}`).set("Idempotency-Key", "pay-init-2").send();
    expect(second.status).toBe(200);
    expect(second.body.paymentId).toBe(first.body.paymentId);
  });
});

describe("Payment webhook (T-072, T-073) — never trust a client callback", () => {
  test("valid signature captures the payment and marks the order paid", async () => {
    const bookingId = await createConfirmedFlightBooking(agencyA.apiKey, "wh1");
    const order = await request(app).post("/v1/orders").set("Authorization", `Bearer ${agencyA.apiKey}`).set("Idempotency-Key", "order-wh1").send({ bookingIds: [bookingId] });
    const pay = await request(app).post(`/v1/orders/${order.body.orderId}/pay`).set("Authorization", `Bearer ${agencyA.apiKey}`).set("Idempotency-Key", "pay-wh1").send();

    const providerRef = pay.body.checkoutUrl.match(/checkout\/(mock_pay_[a-f0-9]+)/)[1];
    const { raw, signature } = signWebhook({ provider_ref: providerRef, status: "captured", amount: order.body.totalPrice, currency: order.body.currency });

    const webhookRes = await request(app).post("/v1/payments/webhook").set("Content-Type", "application/json").set("x-mock-signature", signature).send(raw);
    expect(webhookRes.status).toBe(200);

    const orderAfter = await request(app).get(`/v1/orders/${order.body.orderId}`).set("Authorization", `Bearer ${agencyA.apiKey}`);
    expect(orderAfter.body.status).toBe("paid");
  });

  test("invalid signature is rejected, order is NOT marked paid", async () => {
    const bookingId = await createConfirmedFlightBooking(agencyA.apiKey, "wh2");
    const order = await request(app).post("/v1/orders").set("Authorization", `Bearer ${agencyA.apiKey}`).set("Idempotency-Key", "order-wh2").send({ bookingIds: [bookingId] });
    const pay = await request(app).post(`/v1/orders/${order.body.orderId}/pay`).set("Authorization", `Bearer ${agencyA.apiKey}`).set("Idempotency-Key", "pay-wh2").send();
    const providerRef = pay.body.checkoutUrl.match(/checkout\/(mock_pay_[a-f0-9]+)/)[1];

    const raw = JSON.stringify({ provider_ref: providerRef, status: "captured", amount: order.body.totalPrice, currency: order.body.currency });
    const webhookRes = await request(app).post("/v1/payments/webhook").set("Content-Type", "application/json").set("x-mock-signature", "totally-invalid-signature").send(raw);
    expect(webhookRes.status).toBe(401);

    const orderAfter = await request(app).get(`/v1/orders/${order.body.orderId}`).set("Authorization", `Bearer ${agencyA.apiKey}`);
    expect(orderAfter.body.status).toBe("open"); // NOT paid — this is the core assertion
  });

  test("duplicate webhook delivery for an already-captured payment is a no-op, not double-processed", async () => {
    const bookingId = await createConfirmedFlightBooking(agencyA.apiKey, "wh3");
    const order = await request(app).post("/v1/orders").set("Authorization", `Bearer ${agencyA.apiKey}`).set("Idempotency-Key", "order-wh3").send({ bookingIds: [bookingId] });
    const pay = await request(app).post(`/v1/orders/${order.body.orderId}/pay`).set("Authorization", `Bearer ${agencyA.apiKey}`).set("Idempotency-Key", "pay-wh3").send();
    const providerRef = pay.body.checkoutUrl.match(/checkout\/(mock_pay_[a-f0-9]+)/)[1];

    const { raw, signature } = signWebhook({ provider_ref: providerRef, status: "captured", amount: order.body.totalPrice, currency: order.body.currency });
    await request(app).post("/v1/payments/webhook").set("Content-Type", "application/json").set("x-mock-signature", signature).send(raw);

    const secondDelivery = await request(app).post("/v1/payments/webhook").set("Content-Type", "application/json").set("x-mock-signature", signature).send(raw);
    expect(secondDelivery.status).toBe(200);
    expect(secondDelivery.body.alreadyProcessed).toBe(true);
  });

  test("unknown provider reference is rejected without a 500", async () => {
    const { raw, signature } = signWebhook({ provider_ref: "mock_pay_doesnotexist", status: "captured", amount: 100, currency: "USD" });
    const res = await request(app).post("/v1/payments/webhook").set("Content-Type", "application/json").set("x-mock-signature", signature).send(raw);
    expect(res.status).toBe(404);
  });
});

describe("Refund (T-076)", () => {
  test("refunding a paid order marks payment refunded and order cancelled", async () => {
    const bookingId = await createConfirmedFlightBooking(agencyA.apiKey, "refund1");
    const order = await request(app).post("/v1/orders").set("Authorization", `Bearer ${agencyA.apiKey}`).set("Idempotency-Key", "order-refund1").send({ bookingIds: [bookingId] });
    const pay = await request(app).post(`/v1/orders/${order.body.orderId}/pay`).set("Authorization", `Bearer ${agencyA.apiKey}`).set("Idempotency-Key", "pay-refund1").send();
    const providerRef = pay.body.checkoutUrl.match(/checkout\/(mock_pay_[a-f0-9]+)/)[1];
    const { raw, signature } = signWebhook({ provider_ref: providerRef, status: "captured", amount: order.body.totalPrice, currency: order.body.currency });
    await request(app).post("/v1/payments/webhook").set("Content-Type", "application/json").set("x-mock-signature", signature).send(raw);

    const refundRes = await request(app)
      .post(`/v1/orders/${order.body.orderId}/refund`)
      .set("Authorization", `Bearer ${agencyA.apiKey}`)
      .set("Idempotency-Key", "refund-1")
      .send();
    expect(refundRes.status).toBe(200);
    expect(refundRes.body.status).toBe("cancelled");
  });

  test("cannot refund an order that was never paid", async () => {
    const bookingId = await createConfirmedFlightBooking(agencyA.apiKey, "refund2");
    const order = await request(app).post("/v1/orders").set("Authorization", `Bearer ${agencyA.apiKey}`).set("Idempotency-Key", "order-refund2").send({ bookingIds: [bookingId] });

    const res = await request(app)
      .post(`/v1/orders/${order.body.orderId}/refund`)
      .set("Authorization", `Bearer ${agencyA.apiKey}`)
      .set("Idempotency-Key", "refund-2")
      .send();
    expect(res.status).toBe(400);
  });

  test("a successful refund transitions the underlying booking to 'refunded', not just the payment/order (regression test for the state-propagation fix)", async () => {
    const bookingId = await createConfirmedFlightBooking(agencyA.apiKey, "refund3");
    const order = await request(app).post("/v1/orders").set("Authorization", `Bearer ${agencyA.apiKey}`).set("Idempotency-Key", "order-refund3").send({ bookingIds: [bookingId] });
    const pay = await request(app).post(`/v1/orders/${order.body.orderId}/pay`).set("Authorization", `Bearer ${agencyA.apiKey}`).set("Idempotency-Key", "pay-refund3").send();
    const providerRef = pay.body.checkoutUrl.match(/checkout\/(mock_pay_[a-f0-9]+)/)[1];

    const crypto = require("crypto");
    const raw = JSON.stringify({ provider_ref: providerRef, status: "captured", amount: order.body.totalPrice, currency: order.body.currency, event_id: `evt_${bookingId}` });
    const signature = crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
    await request(app).post("/v1/payments/webhook").set("Content-Type", "application/json").set("x-mock-signature", signature).send(raw);

    await request(app).post(`/v1/orders/${order.body.orderId}/refund`).set("Authorization", `Bearer ${agencyA.apiKey}`).set("Idempotency-Key", "refund-3").send();

    const bookingRes = await request(app).get(`/v1/flights/bookings/${bookingId}`).set("Authorization", `Bearer ${agencyA.apiKey}`);
    expect(bookingRes.body.status).toBe("refunded");
  });

  test("webhook capture is rejected if the underlying booking already moved to cancelled (payment-capture guard)", async () => {
    // This test verifies the guard exists and fires correctly — it directly
    // manipulates the booking's state via the repository to simulate a
    // booking that cancelled between order creation and webhook arrival,
    // since driving that race through the HTTP API alone isn't feasible
    // in a single-threaded test.
    const bookingId = await createConfirmedFlightBooking(agencyA.apiKey, "guard1");
    const order = await request(app).post("/v1/orders").set("Authorization", `Bearer ${agencyA.apiKey}`).set("Idempotency-Key", "order-guard1").send({ bookingIds: [bookingId] });
    const pay = await request(app).post(`/v1/orders/${order.body.orderId}/pay`).set("Authorization", `Bearer ${agencyA.apiKey}`).set("Idempotency-Key", "pay-guard1").send();
    const providerRef = pay.body.checkoutUrl.match(/checkout\/(mock_pay_[a-f0-9]+)/)[1];

    const { Bookings } = require("../src/repositories");
    await Bookings.transition(bookingId, "cancel_requested", { actor: "test", reason: "simulating a race for this test" });
    await Bookings.transition(bookingId, "cancelled", { actor: "test", reason: "simulating a race for this test" });

    const crypto = require("crypto");
    const raw = JSON.stringify({ provider_ref: providerRef, status: "captured", amount: order.body.totalPrice, currency: order.body.currency });
    const signature = crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
    const webhookRes = await request(app).post("/v1/payments/webhook").set("Content-Type", "application/json").set("x-mock-signature", signature).send(raw);

    expect(webhookRes.status).toBe(409);
    expect(webhookRes.body.code).toBe("BOOKING_NOT_CAPTURABLE");

    const orderAfter = await request(app).get(`/v1/orders/${order.body.orderId}`).set("Authorization", `Bearer ${agencyA.apiKey}`);
    expect(orderAfter.body.status).toBe("open"); // NOT paid — money must not move for a cancelled booking
  });
});

describe("Tenant isolation on orders", () => {
  test("agency B cannot see or pay agency A's order", async () => {
    const agencyB = await seedAgency("Orders Agency B");
    const bookingId = await createConfirmedFlightBooking(agencyA.apiKey, "isolation1");
    const order = await request(app).post("/v1/orders").set("Authorization", `Bearer ${agencyA.apiKey}`).set("Idempotency-Key", "order-isolation1").send({ bookingIds: [bookingId] });

    const getRes = await request(app).get(`/v1/orders/${order.body.orderId}`).set("Authorization", `Bearer ${agencyB.apiKey}`);
    expect(getRes.status).toBe(404);

    const payRes = await request(app).post(`/v1/orders/${order.body.orderId}/pay`).set("Authorization", `Bearer ${agencyB.apiKey}`).set("Idempotency-Key", "cross-tenant-pay").send();
    expect(payRes.status).toBe(404);
  });
});
