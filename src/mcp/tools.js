// The eight initial MCP tools, exactly as enumerated in Master Spec §14:
// search_flights, get_flight_offer, book_flight, search_hotels,
// get_hotel_offer, book_hotel, get_booking, cancel_booking. No more, no
// less — scope discipline matters here the same way it did for the REST
// API surface (Master Spec §9): this is not the place to add order/payment
// tools that weren't in the approved tool list, however tempting.
//
// Search tools poll internally (bounded) so the LLM gets a final offers
// list in one call rather than having to understand TAPI's async
// search/poll pattern itself — that pattern exists for REST clients
// managing their own UI state; an LLM tool call is a single request/response,
// so hiding the polling here is the right shape for this interface, not a
// simplification that loses information.
//
// cancel_booking is hotel-only. Flights have no cancellation endpoint in
// the approved MVP API surface (Master Spec §9) — presenting a
// cancel-flight-booking tool that doesn't work would be worse than not
// offering one.
const { tapiRequest, newIdempotencyKey } = require("./tapiClient");

const POLL_INTERVAL_MS = 3000;
const MAX_POLLS = 20; // ~60s ceiling — an MCP tool call shouldn't hang indefinitely

async function pollSearch(kind, searchId) {
  for (let i = 0; i < MAX_POLLS; i++) {
    const result = await tapiRequest("GET", `/v1/${kind}/search/${searchId}`);
    if (result.status !== "processing") return result;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { searchId, status: "processing", note: `Still processing after ${MAX_POLLS} polls — call again later with a fresh search, TAPI does not expose a bare re-poll tool.` };
}

const tools = [
  {
    name: "search_flights",
    description: "Search flights by origin, destination, dates, and passenger counts. Returns normalized, bookable offers.",
    inputSchema: {
      type: "object",
      required: ["origin", "destination", "departDate", "adults"],
      properties: {
        origin: { type: "string", description: "3-letter IATA code, e.g. LOS" },
        destination: { type: "string", description: "3-letter IATA code, e.g. LHR" },
        departDate: { type: "string", description: "YYYY-MM-DD" },
        returnDate: { type: "string", description: "YYYY-MM-DD, omit for one-way" },
        adults: { type: "number" },
        children: { type: "number" },
        infants: { type: "number" },
        cabinClass: { type: "string", enum: ["economy", "premium", "business", "first"] },
      },
    },
    handler: async (args) => {
      const search = await tapiRequest("POST", "/v1/flights/search", {
        body: {
          origin: args.origin,
          destination: args.destination,
          departDate: args.departDate,
          returnDate: args.returnDate,
          passengers: { adults: args.adults, children: args.children, infants: args.infants },
          cabinClass: args.cabinClass,
        },
      });
      return pollSearch("flights", search.searchId);
    },
  },

  {
    name: "get_flight_offer",
    description: "Retrieve full detail for a specific flight offer by ID, and validate/reprice it — call this immediately before book_flight, since offers expire.",
    inputSchema: {
      type: "object",
      required: ["offerId"],
      properties: { offerId: { type: "string" } },
    },
    handler: async (args) => {
      const offer = await tapiRequest("GET", `/v1/flights/offers/${args.offerId}`);
      const validation = await tapiRequest("POST", `/v1/flights/offers/${args.offerId}/validate`);
      return { offer, validation };
    },
  },

  {
    name: "book_flight",
    description: "Book a validated flight offer. Requires full passenger details. Returns booking status — 'confirmed' means a real PNR exists; 'action_required' means the supplier requires further checkout the caller must relay to the customer; 'pending' or 'reconciliation_required' mean the outcome isn't known yet and must NOT be retried with a new request.",
    inputSchema: {
      type: "object",
      required: ["offerId", "passengers", "contactEmail"],
      properties: {
        offerId: { type: "string" },
        passengers: {
          type: "array",
          items: {
            type: "object",
            required: ["firstName", "lastName", "dateOfBirth"],
            properties: {
              firstName: { type: "string" },
              lastName: { type: "string" },
              dateOfBirth: { type: "string", description: "YYYY-MM-DD" },
              passportNumber: { type: "string" },
              nationality: { type: "string" },
            },
          },
        },
        contactEmail: { type: "string" },
        contactPhone: { type: "string" },
        idempotencyKey: { type: "string", description: "Optional — a fresh one is generated if omitted. Reuse the SAME key to safely retry a call that timed out; do NOT generate a new key just because you didn't see a response." },
      },
    },
    handler: async (args) => {
      return tapiRequest("POST", "/v1/flights/bookings", {
        idempotencyKey: args.idempotencyKey || newIdempotencyKey(),
        body: {
          offerId: args.offerId,
          passengers: args.passengers,
          contact: { email: args.contactEmail, phone: args.contactPhone },
        },
      });
    },
  },

  {
    name: "search_hotels",
    description: "Search hotels by destination, check-in/check-out dates, and guest counts. Returns normalized, bookable rate offers.",
    inputSchema: {
      type: "object",
      required: ["destination", "checkIn", "checkOut", "adults"],
      properties: {
        destination: { type: "string" },
        checkIn: { type: "string", description: "YYYY-MM-DD" },
        checkOut: { type: "string", description: "YYYY-MM-DD" },
        adults: { type: "number" },
        children: { type: "number" },
        rooms: { type: "number" },
      },
    },
    handler: async (args) => {
      const search = await tapiRequest("POST", "/v1/hotels/search", {
        body: {
          destination: args.destination,
          checkIn: args.checkIn,
          checkOut: args.checkOut,
          guests: { adults: args.adults, children: args.children },
          rooms: args.rooms,
        },
      });
      return pollSearch("hotels", search.searchId);
    },
  },

  {
    name: "get_hotel_offer",
    description: "Retrieve full detail for a specific hotel rate offer by ID, and run the required rate recheck — call this immediately before book_hotel.",
    inputSchema: {
      type: "object",
      required: ["offerId"],
      properties: { offerId: { type: "string" } },
    },
    handler: async (args) => {
      // hotelId is part of TAPI's frozen public contract (GET
      // /v1/hotels/{hotelId}/offers/{offerId}) but isn't independently
      // validated server-side — offer lookup is tenant+offerId scoped. A
      // placeholder keeps this tool's schema simple without touching the
      // REST contract.
      const offer = await tapiRequest("GET", `/v1/hotels/_/offers/${args.offerId}`);
      const validation = await tapiRequest("POST", `/v1/hotels/offers/${args.offerId}/validate`);
      return { offer, validation };
    },
  },

  {
    name: "book_hotel",
    description: "Book a validated hotel offer. ALWAYS asynchronous — the response status starts 'pending' and must be polled via get_booking. LetsFG charges a 5% non-refundable reservation fee immediately; the remaining balance is paid directly to the hotel via a pay link surfaced once confirmed.",
    inputSchema: {
      type: "object",
      required: ["offerId", "guests", "contactEmail"],
      properties: {
        offerId: { type: "string" },
        guests: {
          type: "array",
          items: {
            type: "object",
            required: ["firstName", "lastName"],
            properties: { firstName: { type: "string" }, lastName: { type: "string" } },
          },
        },
        contactEmail: { type: "string" },
        contactPhone: { type: "string" },
        idempotencyKey: { type: "string", description: "Optional — a fresh one is generated if omitted. Reuse the SAME key to retry; a blindly retried hotel booking can double-book AND double-charge the reservation fee." },
      },
    },
    handler: async (args) => {
      return tapiRequest("POST", "/v1/hotels/bookings", {
        idempotencyKey: args.idempotencyKey || newIdempotencyKey(),
        body: {
          offerId: args.offerId,
          guests: args.guests,
          contact: { email: args.contactEmail, phone: args.contactPhone },
        },
      });
    },
  },

  {
    name: "get_booking",
    description: "Check the current status of a flight or hotel booking. For hotels, once confirmed this also returns the pay link and balance-due date.",
    inputSchema: {
      type: "object",
      required: ["type", "bookingId"],
      properties: {
        type: { type: "string", enum: ["flight", "hotel"] },
        bookingId: { type: "string" },
      },
    },
    handler: async (args) => {
      const path = args.type === "flight" ? `/v1/flights/bookings/${args.bookingId}` : `/v1/hotels/bookings/${args.bookingId}`;
      return tapiRequest("GET", path);
    },
  },

  {
    name: "cancel_booking",
    description: "Cancel a CONFIRMED hotel booking. Flight bookings cannot be cancelled through this API in the current MVP — there is no supported flight cancellation endpoint yet; do not attempt to call this for a flight booking.",
    inputSchema: {
      type: "object",
      required: ["bookingId"],
      properties: {
        bookingId: { type: "string" },
        simulate: { type: "boolean", description: "If true, previews the refund amount without actually cancelling." },
      },
    },
    handler: async (args) => {
      const query = args.simulate ? "?simulate=true" : "";
      return tapiRequest("POST", `/v1/hotels/bookings/${args.bookingId}/cancel${query}`);
    },
  },
];

module.exports = { tools };
