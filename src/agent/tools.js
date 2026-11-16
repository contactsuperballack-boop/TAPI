// Tools the MODEL may call. Deliberately no approve/book/cancel tool: the model
// can search and propose, but only an authenticated user action (a route, not a
// tool call) can create an approval or spend money. tests/unit/agentLoop.test.js
// asserts this list never grows a money-moving tool.
const { toModelView } = require("./piiBoundary");
const { labelPrice } = require("../domain/priceProvenance");

const IATA = /^[A-Z]{3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_OFFERS = 8;

function fail(msg) { const e = new Error(msg); e.code = "BAD_TOOL_ARGS"; throw e; }
function req(args, key, test, hint) {
  if (args[key] === undefined || args[key] === null || (test && !test(args[key]))) fail(`${key}: ${hint}`);
}

const TOOL_SPECS = [
  { name: "get_traveller_profile", description: "Saved traveller preferences (home airport, cabin, hotel tier, dietary, loyalty programme names). Contains no passport or contact data.", inputSchema: { type: "object", properties: {} } },
  { name: "search_flights", description: "Search flights. Prices are estimates until the user approves and the offer is revalidated.", inputSchema: { type: "object", required: ["origin", "destination", "departDate"], properties: {
    origin: { type: "string", description: "3-letter IATA code" }, destination: { type: "string", description: "3-letter IATA code" },
    departDate: { type: "string", description: "YYYY-MM-DD" }, returnDate: { type: "string", description: "YYYY-MM-DD, omit for one-way" },
    adults: { type: "number" }, cabinClass: { type: "string", enum: ["economy", "premium", "business", "first"] } } } },
  { name: "search_hotels", description: "Search hotels. Prices are estimates until the user approves and the rate is rechecked.", inputSchema: { type: "object", required: ["destination", "checkIn", "checkOut"], properties: {
    destination: { type: "string" }, checkIn: { type: "string", description: "YYYY-MM-DD" }, checkOut: { type: "string", description: "YYYY-MM-DD" }, adults: { type: "number" }, rooms: { type: "number" } } } },
  { name: "propose_item", description: "Add an offer from the latest search to the trip as a PROPOSAL for the user to review. Does not book or reserve anything.", inputSchema: { type: "object", required: ["kind", "offerId"], properties: {
    kind: { type: "string", enum: ["flight", "hotel"] }, offerId: { type: "string" } } } },
];

const toolNames = () => TOOL_SPECS.map((t) => t.name);

// ctx: { agencyId, tripId, traveller } ; deps: { tapi, trips: {addProposedItem}, now? }
function createToolHandlers(ctx, deps) {
  const now = () => (deps.now ? deps.now() : new Date());
  const seen = new Map(); // offerId -> {kind, price, currency, retrievedAt}: only offers THIS conversation actually saw can be proposed

  const slim = (kind, offers) => {
    const retrievedAt = now();
    return offers.slice(0, MAX_OFFERS).map((o) => {
      const id = o.offerId || o.id;
      seen.set(id, { kind, price: Number(o.price), currency: o.currency, retrievedAt });
      return { ...o, offerId: id, priceLabel: labelPrice({ source: "tapi", retrievedAt, now: retrievedAt }) };
    });
  };

  return {
    async get_traveller_profile() {
      return toModelView(ctx.traveller || {});
    },
    async search_flights(a) {
      req(a, "origin", (v) => IATA.test(v), "3-letter IATA code, e.g. ABV");
      req(a, "destination", (v) => IATA.test(v), "3-letter IATA code, e.g. LHR");
      req(a, "departDate", (v) => DATE.test(v), "YYYY-MM-DD");
      if (a.returnDate !== undefined) req(a, "returnDate", (v) => DATE.test(v) && v >= a.departDate, "YYYY-MM-DD on or after departDate");
      const r = await deps.tapi.searchFlights(a);
      if (r.status === "processing") return { status: "processing", offers: [], note: "Search still running; tell the user and try again later." };
      return { status: r.status, offers: slim("flight", r.offers || []) };
    },
    async search_hotels(a) {
      req(a, "destination", (v) => typeof v === "string" && v.trim(), "city or area name");
      req(a, "checkIn", (v) => DATE.test(v), "YYYY-MM-DD");
      req(a, "checkOut", (v) => DATE.test(v) && v > a.checkIn, "YYYY-MM-DD after checkIn");
      const r = await deps.tapi.searchHotels(a);
      if (r.status === "processing") return { status: "processing", offers: [], note: "Search still running; tell the user and try again later." };
      return { status: r.status, offers: slim("hotel", r.offers || []) };
    },
    async propose_item(a) {
      req(a, "kind", (v) => v === "flight" || v === "hotel", "flight or hotel");
      req(a, "offerId", (v) => typeof v === "string" && v, "an offerId returned by a search in this conversation");
      const o = seen.get(a.offerId);
      if (!o || o.kind !== a.kind) fail("offerId was not returned by a search in this conversation");
      const item = await deps.trips.addProposedItem({
        agencyId: ctx.agencyId, tripId: ctx.tripId, kind: a.kind, offerId: a.offerId,
        quotedPrice: o.price, currency: o.currency,
        priceLabel: labelPrice({ source: "tapi", retrievedAt: o.retrievedAt, now: now() }),
      });
      return { itemId: item.id, status: "proposed", note: "Awaiting the user's review. Nothing is booked." };
    },
  };
}

module.exports = { TOOL_SPECS, toolNames, createToolHandlers };
