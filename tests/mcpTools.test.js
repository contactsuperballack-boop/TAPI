// Tests the MCP tool layer (src/mcp/tools.js) against a mocked TAPI API —
// does NOT test the MCP SDK transport itself (server.js), since that
// requires @modelcontextprotocol/sdk to actually be installed, which this
// sandbox never had network access to verify. This is the honest boundary:
// the tool logic (schemas, request wiring, polling, idempotency-key
// handling) is fully testable and tested here; whether server.js correctly
// speaks the MCP protocol over stdio is NOT verified by this suite and
// needs `npm install && npm run mcp` checked by hand against a real MCP
// client before trusting it.
process.env.TAPI_API_KEY = "test-key";

describe("MCP tools", () => {
  test("exposes exactly the eight tools in Master Spec §14, no more, no less", () => {
    const { tools } = require("../src/mcp/tools");
    expect(tools.map((t) => t.name)).toEqual([
      "search_flights", "get_flight_offer", "book_flight",
      "search_hotels", "get_hotel_offer", "book_hotel",
      "get_booking", "cancel_booking",
    ]);
    for (const t of tools) {
      expect(typeof t.handler).toBe("function");
      expect(t.inputSchema.type).toBe("object");
      expect(typeof t.description).toBe("string");
    }
  });

  test("search_flights polls until completed and returns offers", async () => {
    global.fetch = jest.fn(async (url, opts) => {
      if (url.includes("/flights/search") && opts.method === "POST") return { ok: true, json: async () => ({ searchId: "s1", status: "processing" }) };
      if (url.includes("/flights/search/s1")) return { ok: true, json: async () => ({ searchId: "s1", status: "completed", offers: [{ offerId: "o1" }] }) };
      throw new Error("unexpected: " + url);
    });
    const { tools } = require("../src/mcp/tools");
    const result = await tools.find((t) => t.name === "search_flights").handler({ origin: "LOS", destination: "LHR", departDate: "2026-12-01", adults: 1 });
    expect(result.status).toBe("completed");
    expect(result.offers[0].offerId).toBe("o1");
  });

  test("book_flight always sends an Idempotency-Key, generating one if not provided", async () => {
    let capturedHeaders;
    global.fetch = jest.fn(async (url, opts) => {
      capturedHeaders = opts.headers;
      return { ok: true, json: async () => ({ bookingId: "b1", status: "confirmed" }) };
    });
    const { tools } = require("../src/mcp/tools");
    await tools.find((t) => t.name === "book_flight").handler({
      offerId: "o1",
      passengers: [{ firstName: "A", lastName: "B", dateOfBirth: "1990-01-01" }],
      contactEmail: "a@b.com",
    });
    expect(capturedHeaders["Idempotency-Key"]).toBeTruthy();
  });

  test("book_flight reuses a caller-supplied idempotency key rather than overwriting it", async () => {
    let capturedHeaders;
    global.fetch = jest.fn(async (url, opts) => {
      capturedHeaders = opts.headers;
      return { ok: true, json: async () => ({ bookingId: "b1", status: "confirmed" }) };
    });
    const { tools } = require("../src/mcp/tools");
    await tools.find((t) => t.name === "book_flight").handler({
      offerId: "o1",
      passengers: [{ firstName: "A", lastName: "B", dateOfBirth: "1990-01-01" }],
      contactEmail: "a@b.com",
      idempotencyKey: "caller-supplied-key",
    });
    expect(capturedHeaders["Idempotency-Key"]).toBe("caller-supplied-key");
  });

  test("cancel_booking only ever targets the hotel cancel endpoint", async () => {
    global.fetch = jest.fn(async (url) => {
      expect(url).toContain("/v1/hotels/bookings/hbkg_1/cancel");
      return { ok: true, json: async () => ({ status: "cancelled" }) };
    });
    const { tools } = require("../src/mcp/tools");
    const result = await tools.find((t) => t.name === "cancel_booking").handler({ bookingId: "hbkg_1" });
    expect(result.status).toBe("cancelled");
  });

  test("get_booking routes to flights or hotels based on the type argument", async () => {
    global.fetch = jest.fn(async (url) => {
      if (url.includes("/v1/flights/bookings/fb1")) return { ok: true, json: async () => ({ bookingId: "fb1", status: "confirmed" }) };
      if (url.includes("/v1/hotels/bookings/hb1")) return { ok: true, json: async () => ({ bookingId: "hb1", status: "pending" }) };
      throw new Error("unexpected: " + url);
    });
    const { tools } = require("../src/mcp/tools");
    const flightResult = await tools.find((t) => t.name === "get_booking").handler({ type: "flight", bookingId: "fb1" });
    expect(flightResult.bookingId).toBe("fb1");
    const hotelResult = await tools.find((t) => t.name === "get_booking").handler({ type: "hotel", bookingId: "hb1" });
    expect(hotelResult.bookingId).toBe("hb1");
  });

  test("a TAPI error response surfaces its code/detail, not a bare HTTP error", async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 410, json: async () => ({ code: "OFFER_EXPIRED", detail: "Offer expired" }) }));
    const { tools } = require("../src/mcp/tools");
    await expect(tools.find((t) => t.name === "get_flight_offer").handler({ offerId: "expired" })).rejects.toMatchObject({ code: "OFFER_EXPIRED" });
  });
});
