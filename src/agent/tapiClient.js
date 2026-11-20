// HTTP client the agent uses to reach TAPI. Same boundary the MCP server
// uses (mcp/tapiClient.js): the agent never talks to a supplier and never
// bypasses tenant scoping, rate limits, audit or idempotency. Unlike the MCP
// module this is a factory, so tests can inject fetch and one process can
// serve more than one agency.
const { randomUUID } = require("crypto");

function createTapiClient({ baseUrl, apiKey, headers: extraHeaders = {}, timeoutMs = 15_000, bookingTimeoutMs = 45_000, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollIntervalMs = 3000, maxPolls = 20 }) {
  if (!apiKey) throw new Error("apiKey is required");
  if (!baseUrl) throw new Error("baseUrl is required");

  // Every call has a hard deadline (an aborted fetch frees us; it cannot cancel work already started on the server,
  // so a timeout on a booking is an AMBIGUOUS outcome, which domain/bookingFailure.js treats as such).
  async function request(method, path, { body, idempotencyKey, timeout = timeoutMs } = {}) {
    const headers = { ...extraHeaders, Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    // Explicit controller + timer (cleared when the call ends) rather than AbortSignal.timeout: nothing lingers after the call.
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeout);
    let res; let data;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
      data = await res.json().catch(() => ({}));
    } catch (e) {
      const timedOut = ctrl.signal.aborted || (e && (e.name === "TimeoutError" || e.name === "AbortError"));
      throw Object.assign(new Error(timedOut ? "TAPI request timed out" : "TAPI request could not be sent"), { code: timedOut ? "TIMEOUT" : "NETWORK" });
    } finally { clearTimeout(timer); }
    if (!res.ok) {
      const err = new Error(data.detail || data.title || `TAPI request failed: ${res.status}`);
      err.status = res.status;
      err.code = data.code;
      throw err;
    }
    return data;
  }

  async function poll(kind, searchId) {
    for (let i = 0; i < maxPolls; i++) {
      const r = await request("GET", `/v1/${kind}/search/${searchId}`);
      if (r.status !== "processing") return r;
      await sleep(pollIntervalMs);
    }
    return { searchId, status: "processing", offers: [] };
  }

  return {
    request,
    async searchFlights(p) {
      const s = await request("POST", "/v1/flights/search", { body: {
        origin: p.origin, destination: p.destination, departDate: p.departDate, returnDate: p.returnDate,
        passengers: { adults: p.adults ?? 1, children: p.children, infants: p.infants }, cabinClass: p.cabinClass } });
      return poll("flights", s.searchId);
    },
    async searchHotels(p) {
      const s = await request("POST", "/v1/hotels/search", { body: {
        destination: p.destination, checkIn: p.checkIn, checkOut: p.checkOut,
        guests: { adults: p.adults ?? 1, children: p.children }, rooms: p.rooms } });
      return poll("hotels", s.searchId);
    },
    // Revalidate right before booking; returns TAPI's own validation verdict.
    async validateFlightOffer(offerId) {
      return request("POST", `/v1/flights/offers/${offerId}/validate`);
    },
    async validateHotelOffer(offerId) {
      return request("POST", `/v1/hotels/offers/${offerId}/validate`);
    },
    async bookFlight(body, idempotencyKey) {
      return request("POST", "/v1/flights/bookings", { body, idempotencyKey, timeout: bookingTimeoutMs });
    },
    async bookHotel(body, idempotencyKey) {
      return request("POST", "/v1/hotels/bookings", { body, idempotencyKey, timeout: bookingTimeoutMs });
    },
    async getBooking(kind, id) {
      return request("GET", `/v1/${kind === "flight" ? "flights" : "hotels"}/bookings/${id}`);
    },
    newIdempotencyKey: () => randomUUID(),
  };
}

module.exports = { createTapiClient };
