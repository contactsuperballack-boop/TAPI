#!/usr/bin/env node
// TAPI CLI — smoke-test/diagnostic interface over the same API (Master Spec §15).
// Never bypasses API/domain authorization; every command just calls the HTTP API.
require("dotenv").config();
const { Command } = require("commander");

const program = new Command();
const BASE_URL = process.env.TAPI_BASE_URL || "http://localhost:3000";

function authHeaders() {
  const key = process.env.TAPI_API_KEY;
  if (!key) throw new Error("Set TAPI_API_KEY to run CLI commands.");
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

program.name("tapi").description("TAPI CLI — flight search/booking smoke tests");

program
  .command("search")
  .requiredOption("--origin <code>")
  .requiredOption("--destination <code>")
  .requiredOption("--depart <date>")
  .option("--return <date>")
  .option("--adults <n>", "adults", "1")
  .action(async (opts) => {
    const res = await fetch(`${BASE_URL}/v1/flights/search`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        origin: opts.origin,
        destination: opts.destination,
        departDate: opts.depart,
        returnDate: opts.return,
        passengers: { adults: Number(opts.adults) },
      }),
    });
    console.log(JSON.stringify(await res.json(), null, 2));
  });

program
  .command("poll <searchId>")
  .action(async (searchId) => {
    const res = await fetch(`${BASE_URL}/v1/flights/search/${searchId}`, { headers: authHeaders() });
    console.log(JSON.stringify(await res.json(), null, 2));
  });

program
  .command("book")
  .requiredOption("--offer <offerId>")
  .requiredOption("--idempotency-key <key>")
  .action(async (opts) => {
    const res = await fetch(`${BASE_URL}/v1/flights/bookings`, {
      method: "POST",
      headers: { ...authHeaders(), "Idempotency-Key": opts.idempotencyKey },
      body: JSON.stringify({
        offerId: opts.offer,
        passengers: [{ firstName: "Test", lastName: "Traveler", dateOfBirth: "1990-01-01" }],
        contact: { email: "test@example.com" },
      }),
    });
    console.log(JSON.stringify(await res.json(), null, 2));
  });

program
  .command("smoke-test")
  .description("Runs the full vertical slice: search -> poll -> book, for machine-readable CI use")
  .requiredOption("--origin <code>")
  .requiredOption("--destination <code>")
  .requiredOption("--depart <date>")
  .action(async (opts) => {
    console.log(`[1/3] searching ${opts.origin} -> ${opts.destination} on ${opts.depart}`);
    const searchRes = await fetch(`${BASE_URL}/v1/flights/search`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        origin: opts.origin,
        destination: opts.destination,
        departDate: opts.depart,
        passengers: { adults: 1 },
      }),
    }).then((r) => r.json());

    console.log(`[2/3] polling search ${searchRes.searchId}`);
    let result;
    for (let i = 0; i < 10; i++) {
      result = await fetch(`${BASE_URL}/v1/flights/search/${searchRes.searchId}`, { headers: authHeaders() }).then((r) => r.json());
      if (result.status !== "processing") break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    if (result.status !== "completed" || !result.offers?.length) {
      console.error(JSON.stringify({ ok: false, stage: "search", result }, null, 2));
      process.exit(1);
    }

    console.log(`[3/3] booking offer ${result.offers[0].offerId}`);
    const bookRes = await fetch(`${BASE_URL}/v1/flights/bookings`, {
      method: "POST",
      headers: { ...authHeaders(), "Idempotency-Key": `smoke-${Date.now()}` },
      body: JSON.stringify({
        offerId: result.offers[0].offerId,
        passengers: [{ firstName: "Test", lastName: "Traveler", dateOfBirth: "1990-01-01" }],
        contact: { email: "test@example.com" },
      }),
    }).then((r) => r.json());

    console.log(JSON.stringify({ ok: bookRes.status === "confirmed", booking: bookRes }, null, 2));
    process.exit(bookRes.status === "confirmed" ? 0 : 1);
  });

program
  .command("hotel-search")
  .requiredOption("--destination <query>")
  .requiredOption("--check-in <date>")
  .requiredOption("--check-out <date>")
  .option("--adults <n>", "adults", "1")
  .action(async (opts) => {
    const res = await fetch(`${BASE_URL}/v1/hotels/search`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        destination: opts.destination,
        checkIn: opts.checkIn,
        checkOut: opts.checkOut,
        guests: { adults: Number(opts.adults) },
      }),
    });
    console.log(JSON.stringify(await res.json(), null, 2));
  });

program
  .command("hotel-poll <searchId>")
  .action(async (searchId) => {
    const res = await fetch(`${BASE_URL}/v1/hotels/search/${searchId}`, { headers: authHeaders() });
    console.log(JSON.stringify(await res.json(), null, 2));
  });

program
  .command("hotel-book")
  .requiredOption("--offer <offerId>")
  .requiredOption("--idempotency-key <key>")
  .action(async (opts) => {
    const res = await fetch(`${BASE_URL}/v1/hotels/bookings`, {
      method: "POST",
      headers: { ...authHeaders(), "Idempotency-Key": opts.idempotencyKey },
      body: JSON.stringify({
        offerId: opts.offer,
        guests: [{ firstName: "Test", lastName: "Guest" }],
        contact: { email: "test@example.com" },
      }),
    });
    console.log(JSON.stringify(await res.json(), null, 2));
  });

program
  .command("hotel-booking-status <bookingId>")
  .description("Polls a hotel booking job until confirmed/failed, printing pay_link/balance_due_by once available")
  .action(async (bookingId) => {
    const res = await fetch(`${BASE_URL}/v1/hotels/bookings/${bookingId}`, { headers: authHeaders() });
    console.log(JSON.stringify(await res.json(), null, 2));
  });

program
  .command("keys-create")
  .option("--label <label>")
  .option("--expires-in-days <n>")
  .action(async (opts) => {
    const res = await fetch(`${BASE_URL}/v1/auth/api-keys`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        label: opts.label,
        expiresInDays: opts.expiresInDays ? Number(opts.expiresInDays) : undefined,
      }),
    });
    console.log(JSON.stringify(await res.json(), null, 2));
  });

program
  .command("keys-list")
  .action(async () => {
    const res = await fetch(`${BASE_URL}/v1/auth/api-keys`, { headers: authHeaders() });
    console.log(JSON.stringify(await res.json(), null, 2));
  });

program
  .command("keys-revoke <id>")
  .action(async (id) => {
    const res = await fetch(`${BASE_URL}/v1/auth/api-keys/${id}/revoke`, { method: "POST", headers: authHeaders() });
    console.log(JSON.stringify(await res.json(), null, 2));
  });

program
  .command("order-create")
  .requiredOption("--booking <bookingId>", "repeatable", (val, prev) => prev.concat([val]), [])
  .requiredOption("--idempotency-key <key>")
  .action(async (opts) => {
    const res = await fetch(`${BASE_URL}/v1/orders`, {
      method: "POST",
      headers: { ...authHeaders(), "Idempotency-Key": opts.idempotencyKey },
      body: JSON.stringify({ bookingIds: opts.booking }),
    });
    console.log(JSON.stringify(await res.json(), null, 2));
  });

program
  .command("order-get <orderId>")
  .action(async (orderId) => {
    const res = await fetch(`${BASE_URL}/v1/orders/${orderId}`, { headers: authHeaders() });
    console.log(JSON.stringify(await res.json(), null, 2));
  });

program
  .command("order-pay <orderId>")
  .requiredOption("--idempotency-key <key>")
  .action(async (orderId, opts) => {
    const res = await fetch(`${BASE_URL}/v1/orders/${orderId}/pay`, {
      method: "POST",
      headers: { ...authHeaders(), "Idempotency-Key": opts.idempotencyKey },
    });
    console.log(JSON.stringify(await res.json(), null, 2));
  });

program
  .command("order-refund <orderId>")
  .requiredOption("--idempotency-key <key>")
  .action(async (orderId, opts) => {
    const res = await fetch(`${BASE_URL}/v1/orders/${orderId}/refund`, {
      method: "POST",
      headers: { ...authHeaders(), "Idempotency-Key": opts.idempotencyKey },
    });
    console.log(JSON.stringify(await res.json(), null, 2));
  });

program.parse();
