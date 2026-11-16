// Integration tests against a real (throwaway) Postgres, mirroring the
// pattern used by flights.test.js / hotels.test.js. The mobility module
// (src/routes/mobility.routes.js, migration 010) shipped with zero test
// coverage — this suite closes that gap. It also regression-tests the
// Sprint 1 fix that merged mobility's separate `audit_logs` table into the
// shared `audit_events` table (migration 011): every mutating mobility
// action should now show up in the same audit trail flights/hotels/orders
// already use, not a parallel one nothing else queries.
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
  agencyA = await seedAgency("Mobility Agency A");
  agencyB = await seedAgency("Mobility Agency B");
  app = require("../src/app");
});

afterAll(async () => {
  await closeDb();
});

const authA = () => ["Authorization", `Bearer ${agencyA.apiKey}`];
const authB = () => ["Authorization", `Bearer ${agencyB.apiKey}`];

async function createOperator(auth) {
  const res = await request(app)
    .post("/v1/mobility/operators")
    .set(...auth)
    .send({ name: "Coastal Coaches", code: `CC-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` });
  expect(res.status).toBe(201);
  return res.body;
}

async function createTrip(auth, operatorId, seats = ["1A", "1B", "1C"]) {
  const res = await request(app)
    .post("/v1/mobility/trips")
    .set(...auth)
    .send({
      operatorId,
      tripCode: `TRIP-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      origin: "Lagos",
      destination: "Abuja",
      departureAt: new Date(Date.now() + 86_400_000).toISOString(),
      fare: 42.5,
      seats,
    });
  expect(res.status).toBe(201);
  return res.body;
}

describe("Mobility operators & trips", () => {
  test("creates an operator and a trip with seat inventory", async () => {
    const operator = await createOperator(authA());
    expect(operator.agency_id).toBe(agencyA.agencyId);

    const trip = await createTrip(authA(), operator.id);
    expect(trip.seats).toHaveLength(3);
    expect(trip.origin).toBe("Lagos");
  });

  test("rejects a trip for an operator that doesn't belong to the tenant", async () => {
    const operator = await createOperator(authA());
    const res = await request(app)
      .post("/v1/mobility/trips")
      .set(...authB())
      .send({
        operatorId: operator.id,
        tripCode: `CROSS-${Date.now()}`,
        origin: "Lagos",
        destination: "Abuja",
        departureAt: new Date(Date.now() + 86_400_000).toISOString(),
        fare: 10,
        seats: ["1A"],
      });
    expect(res.status).toBe(404);
  });

  test("lists trips scoped to the requesting tenant only", async () => {
    const operator = await createOperator(authA());
    await createTrip(authA(), operator.id);

    const resA = await request(app).get("/v1/mobility/trips").set(...authA());
    const resB = await request(app).get("/v1/mobility/trips").set(...authB());
    expect(resA.body.trips.length).toBeGreaterThan(0);
    expect(resB.body.trips.every((t) => t.agency_id !== agencyA.agencyId)).toBe(true);
  });
});

describe("Seat holds", () => {
  test("holds available seats and blocks a conflicting hold", async () => {
    const operator = await createOperator(authA());
    const trip = await createTrip(authA(), operator.id, ["2A", "2B"]);
    const seatIds = trip.seats.map((s) => s.id);

    const hold = await request(app)
      .post(`/v1/mobility/trips/${trip.id}/holds`)
      .set(...authA())
      .send({ seatIds: [seatIds[0]], ttlSeconds: 300 });
    expect(hold.status).toBe(201);
    expect(hold.body.status).toBe("active");

    const conflicting = await request(app)
      .post(`/v1/mobility/trips/${trip.id}/holds`)
      .set(...authA())
      .send({ seatIds: [seatIds[0]] });
    expect(conflicting.status).toBe(409);
    expect(conflicting.body.code).toBe("SEATS_UNAVAILABLE");
  });

  test("releasing a hold frees the seat for a new hold", async () => {
    const operator = await createOperator(authA());
    const trip = await createTrip(authA(), operator.id, ["3A"]);
    const seatId = trip.seats[0].id;

    const hold = await request(app)
      .post(`/v1/mobility/trips/${trip.id}/holds`)
      .set(...authA())
      .send({ seatIds: [seatId] });

    const released = await request(app)
      .post(`/v1/mobility/holds/${hold.body.id}/release`)
      .set(...authA());
    expect(released.status).toBe(200);
    expect(released.body.status).toBe("released");

    const secondHold = await request(app)
      .post(`/v1/mobility/trips/${trip.id}/holds`)
      .set(...authA())
      .send({ seatIds: [seatId] });
    expect(secondHold.status).toBe(201);
  });
});

describe("Mobility bookings", () => {
  test("requires an Idempotency-Key header", async () => {
    const operator = await createOperator(authA());
    const trip = await createTrip(authA(), operator.id, ["4A"]);
    const hold = await request(app)
      .post(`/v1/mobility/trips/${trip.id}/holds`)
      .set(...authA())
      .send({ seatIds: [trip.seats[0].id] });

    const res = await request(app)
      .post("/v1/mobility/bookings")
      .set(...authA())
      .send({ tripId: trip.id, holdId: hold.body.id, passenger: { name: "A. Traveler" } });
    expect(res.status).toBe(400);
  });

  test("books a held seat, is idempotent on retry, and rejects an expired hold", async () => {
    const operator = await createOperator(authA());
    const trip = await createTrip(authA(), operator.id, ["5A"]);
    const hold = await request(app)
      .post(`/v1/mobility/trips/${trip.id}/holds`)
      .set(...authA())
      .send({ seatIds: [trip.seats[0].id] });

    const key = `book-${Date.now()}`;
    const body = { tripId: trip.id, holdId: hold.body.id, passenger: { name: "A. Traveler" } };

    const first = await request(app)
      .post("/v1/mobility/bookings")
      .set(...authA())
      .set("Idempotency-Key", key)
      .send(body);
    expect(first.status).toBe(201);
    expect(first.body.status).toBe("pending");
    expect(Number(first.body.total_amount)).toBeCloseTo(42.5);

    // Retry with the same key must return the same booking, not double-book
    // the seat or error — same pattern as Bookings.createOrGetExisting for
    // flights/hotels.
    const retry = await request(app)
      .post("/v1/mobility/bookings")
      .set(...authA())
      .set("Idempotency-Key", key)
      .send(body);
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(first.body.id);

    // A fresh idempotency key against the now-converted hold must fail —
    // the hold was consumed by the first booking.
    const secondAttempt = await request(app)
      .post("/v1/mobility/bookings")
      .set(...authA())
      .set("Idempotency-Key", `book-${Date.now()}-second`)
      .send(body);
    expect(secondAttempt.status).toBe(409);
    expect(secondAttempt.body.code).toBe("HOLD_EXPIRED");
  });

  test("rejects the same Idempotency-Key reused with a different request body", async () => {
    const operator = await createOperator(authA());
    const trip = await createTrip(authA(), operator.id, ["5B", "5C"]);
    const hold1 = await request(app)
      .post(`/v1/mobility/trips/${trip.id}/holds`)
      .set(...authA())
      .send({ seatIds: [trip.seats[0].id] });

    const key = `book-reuse-${Date.now()}`;
    const first = await request(app)
      .post("/v1/mobility/bookings")
      .set(...authA())
      .set("Idempotency-Key", key)
      .send({ tripId: trip.id, holdId: hold1.body.id, passenger: { name: "A. Traveler" } });
    expect(first.status).toBe(201);

    // Same key, different hold/passenger — must be rejected, not silently
    // return the first booking (Sprint 1 regression: previously it would
    // have returned the original booking with a 200, masking that the
    // second request's actual content was ignored).
    const hold2 = await request(app)
      .post(`/v1/mobility/trips/${trip.id}/holds`)
      .set(...authA())
      .send({ seatIds: [trip.seats[1].id] });
    const reused = await request(app)
      .post("/v1/mobility/bookings")
      .set(...authA())
      .set("Idempotency-Key", key)
      .send({ tripId: trip.id, holdId: hold2.body.id, passenger: { name: "Someone Else" } });
    expect(reused.status).toBe(422);
    expect(reused.body.code).toBe("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY");
  });

  test("enforces the booking transition map (pending -> confirmed -> boarded, no skipping)", async () => {
    const operator = await createOperator(authA());
    const trip = await createTrip(authA(), operator.id, ["6A"]);
    const hold = await request(app)
      .post(`/v1/mobility/trips/${trip.id}/holds`)
      .set(...authA())
      .send({ seatIds: [trip.seats[0].id] });
    const booking = await request(app)
      .post("/v1/mobility/bookings")
      .set(...authA())
      .set("Idempotency-Key", `book-${Date.now()}-transition`)
      .send({ tripId: trip.id, holdId: hold.body.id, passenger: { name: "A. Traveler" } });

    // Cannot skip straight to boarded.
    const skip = await request(app)
      .post(`/v1/mobility/bookings/${booking.body.id}/transitions`)
      .set(...authA())
      .send({ toStatus: "boarded" });
    expect(skip.status).toBe(409);
    expect(skip.body.code).toBe("INVALID_BOOKING_TRANSITION");

    const confirm = await request(app)
      .post(`/v1/mobility/bookings/${booking.body.id}/transitions`)
      .set(...authA())
      .send({ toStatus: "confirmed" });
    expect(confirm.status).toBe(200);
    expect(confirm.body.status).toBe("confirmed");

    const board = await request(app)
      .post(`/v1/mobility/bookings/${booking.body.id}/transitions`)
      .set(...authA())
      .send({ toStatus: "boarded" });
    expect(board.status).toBe(200);
    expect(board.body.status).toBe("boarded");

    // boarded is terminal — no further transitions allowed.
    const dead = await request(app)
      .post(`/v1/mobility/bookings/${booking.body.id}/transitions`)
      .set(...authA())
      .send({ toStatus: "cancelled" });
    expect(dead.status).toBe(409);
  });

  test("a booking's tenant cannot be read by another agency", async () => {
    const operator = await createOperator(authA());
    const trip = await createTrip(authA(), operator.id, ["7A"]);
    const hold = await request(app)
      .post(`/v1/mobility/trips/${trip.id}/holds`)
      .set(...authA())
      .send({ seatIds: [trip.seats[0].id] });
    const booking = await request(app)
      .post("/v1/mobility/bookings")
      .set(...authA())
      .set("Idempotency-Key", `book-${Date.now()}-isolation`)
      .send({ tripId: trip.id, holdId: hold.body.id, passenger: { name: "A. Traveler" } });

    const res = await request(app)
      .get(`/v1/mobility/bookings/${booking.body.id}`)
      .set(...authB());
    expect(res.status).toBe(404);
  });
});

describe("Audit trail consolidation (Sprint 1 regression test)", () => {
  test("mobility actions write to audit_events, not a separate table", async () => {
    const db = require("../src/db");
    const operator = await createOperator(authA());

    const { rows } = await db.query(
      `SELECT * FROM audit_events WHERE agency_id = $1 AND resource_type = 'seat_hold' OR (agency_id = $1 AND action = 'booking.created') ORDER BY created_at DESC LIMIT 5`,
      [agencyA.agencyId]
    );
    // Just creating an operator doesn't audit (only holds/bookings do per
    // mobility.routes.js), so drive a hold to generate a real event.
    const trip = await createTrip(authA(), operator.id, ["8A"]);
    await request(app)
      .post(`/v1/mobility/trips/${trip.id}/holds`)
      .set(...authA())
      .send({ seatIds: [trip.seats[0].id] });

    const after = await db.query(
      `SELECT * FROM audit_events WHERE agency_id = $1 AND action = 'hold.created' ORDER BY created_at DESC LIMIT 1`,
      [agencyA.agencyId]
    );
    expect(after.rows.length).toBe(1);
    expect(after.rows[0].resource_type).toBe("seat_hold");

    // The old table should no longer exist at all post-migration 011.
    await expect(db.query(`SELECT * FROM audit_logs LIMIT 1`)).rejects.toThrow();
  });
});

describe("Settlements & integrations", () => {
  test("creates and lists a settlement scoped to the operator's tenant", async () => {
    const operator = await createOperator(authA());
    const res = await request(app)
      .post("/v1/mobility/settlements")
      .set(...authA())
      .send({
        operatorId: operator.id,
        periodStart: "2026-01-01",
        periodEnd: "2026-01-31",
        amount: 1000,
      });
    expect(res.status).toBe(201);

    const list = await request(app).get("/v1/mobility/settlements").set(...authA());
    expect(list.body.settlements.some((s) => s.id === res.body.id)).toBe(true);
  });

  test("dashboard summary returns counts scoped to the tenant", async () => {
    const res = await request(app).get("/v1/mobility/dashboard/summary").set(...authA());
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("trips");
    expect(res.body).toHaveProperty("holds");
    expect(res.body).toHaveProperty("bookings");
  });
});
