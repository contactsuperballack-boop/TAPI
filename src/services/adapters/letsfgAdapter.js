// LetsFG flight adapter — implements FlightSupplier against the real,
// published LetsFG API (letsfg.co). Confirmed from LetsFG's own docs/README
// as of this writing:
//
//   PFS path (free):
//     - Auth: `letsfg auth` puts a card on file (zero-amount Stripe setup,
//       no charge) and issues a 90-day Bearer token.
//     - POST https://letsfg.co/api/search            (bot-protected, token required)
//     - GET  https://letsfg.co/api/results/<search_id>  (poll every ~10s)
//     - Ranking is applied client-side by the open-source SDK, not the server.
//
//   Developer API path (paid, prepaid credits):
//     - POST https://letsfg.co/developers/api/v1/flights/search        (1 credit, 60-90s)
//     - POST https://letsfg.co/developers/api/v1/flights/search/async  (non-blocking + poll)
//     - POST https://letsfg.co/developers/api/v1/flights/discover      (indicative, 20 dest, 1 credit)
//     - POST https://letsfg.co/developers/api/v1/flights/parse-query   (free, NL parsing)
//     - POST https://letsfg.co/developers/api/v1/sandbox/flights/*     (free, fake data, same schema)
//
// !! IMPORTANT UNVERIFIED ASSUMPTION — confirm before beta (Backlog T-062) !!
// LetsFG's own materials describe results as including a direct airline
// `booking_url` "no checkout, no concierge fee" rather than a server-side
// booking API that returns a PNR on TAPI's behalf. If that's accurate, T-046
// ("Flight booking — traveler mapping, supplier booking, confirmation/PNR
// persistence") may need to become "hand off to airline checkout and poll/
// reconcile status" rather than a synchronous book() call. Do NOT treat the
// `book()` method below as confirmed working — it is written against the
// PFS `/api/agent-book` reference mentioned in LetsFG's SDK notes, but must
// be verified against sandbox (T-062/T-063/T-064) before any real booking
// is attempted. Use `/sandbox/flights/*` for that verification first.

const { FlightSupplier } = require("../flightSupplier.interface");
const { LetsFGClient } = require("./letsfgClient");
const { Errors } = require("../../domain/errors");

class LetsFGAdapter extends FlightSupplier {
  constructor(config) {
    super();
    this.client = new LetsFGClient(config);
  }

  // --- resolveLocation ---------------------------------------------------
  // Not separately documented as a dedicated endpoint in LetsFG's public
  // materials at time of writing; /flights/parse-query (Developer API, free)
  // does natural-language parsing which can substitute for airport/city
  // resolution — but that endpoint requires Developer auth (X-API-Key), not
  // a PFS Bearer token. Previously this method used the Developer path
  // unconditionally, which would silently fail (wrong auth header) in PFS
  // mode. Fail loudly instead — there is no known PFS-mode equivalent to
  // fall back to; confirm one exists in sandbox before assuming otherwise.
  async resolveLocation(query) {
    if (this.client.authMode !== "developer") {
      throw new Error(
        "LetsFGAdapter.resolveLocation() has no confirmed PFS-mode endpoint — only the Developer API's " +
          "/flights/parse-query is documented, and it requires an X-API-Key, not a PFS Bearer token. " +
          "Set LETSFG_AUTH_MODE=developer to use this method, or confirm a PFS equivalent against sandbox first."
      );
    }
    const data = await this.client.request("POST", "/developers/api/v1/flights/parse-query", { query });
    return data.locations || [];
  }

  // --- search / pollSearch ------------------------------------------------
  async search({ origin, destination, departDate, returnDate, adults, children, infants, cabinClass }) {
    const path = this.client.authMode === "pfs" ? "/api/search" : "/developers/api/v1/flights/search/async";
    const payload = {
      origin,
      destination,
      depart_date: departDate,
      return_date: returnDate || undefined,
      passengers: { adults, children: children || 0, infants: infants || 0 },
      cabin_class: cabinClass || "economy",
    };
    const data = await this.client.request("POST", path, payload);
    return { supplierSearchRef: data.search_id };
  }

  async pollSearch(supplierSearchRef) {
    const path =
      this.client.authMode === "pfs"
        ? `/api/results/${supplierSearchRef}`
        : `/developers/api/v1/flights/search/${supplierSearchRef}`;
    const data = await this.client.request("GET", path);
    return {
      status: data.status, // 'processing' | 'completed' | 'failed'
      offers: (data.offers || []).map(normalizeOffer),
    };
  }

  // --- offer / validate / book --------------------------------------------
  async getOffer(supplierOfferRef) {
    const path =
      this.client.authMode === "pfs"
        ? `/api/offers/${supplierOfferRef}`
        : `/developers/api/v1/flights/offers/${supplierOfferRef}`; // UNVERIFIED — follows the {product}/{action} convention used elsewhere in the Developer API; confirm against sandbox
    const data = await this.client.request("GET", path);
    return normalizeOffer(data);
  }

  async validateOffer(supplierOfferRef) {
    // Developer API path requires unlock() before book() (rate-limited 20/min
    // per LetsFG SDK notes). PFS path books directly without an unlock step.
    if (this.client.authMode !== "developer") {
      return { valid: true, offer: await this.getOffer(supplierOfferRef) };
    }
    const data = await this.client.request("POST", `/developers/api/v1/flights/offers/${supplierOfferRef}/unlock`);
    if (data.price_changed) throw Errors.PriceChanged(`Offer ${supplierOfferRef} repriced by LetsFG`);
    if (data.sold_out) throw Errors.SoldOut();
    return { valid: true, offer: normalizeOffer(data.offer) };
  }

  async book(supplierOfferRef, passengers, contact) {
    // UNVERIFIED — see module header. PFS path per SDK notes: POST
    // /api/agent-book, one passenger per call. Developer path: POST
    // .../bookings, multi-passenger in one call, rate-limited 10/min.
    const path = this.client.authMode === "pfs" ? "/api/agent-book" : "/developers/api/v1/flights/bookings";
    const data = await this.client.request("POST", path, {
      offer_id: supplierOfferRef,
      passengers,
      contact,
    });
    return {
      supplierBookingRef: data.booking_id || data.pnr,
      status: data.status || "pending",
      pnr: data.pnr,
      bookingUrl: data.booking_url, // present if LetsFG hands off to airline checkout instead of booking directly
      raw: data,
    };
  }

  async getBooking(supplierBookingRef) {
    const path =
      this.client.authMode === "pfs"
        ? `/api/bookings/${supplierBookingRef}`
        : `/developers/api/v1/flights/bookings/${supplierBookingRef}`; // UNVERIFIED, same convention caveat as getOffer
    const data = await this.client.request("GET", path);
    return { status: data.status, pnr: data.pnr, raw: data };
  }

  async cancel(supplierBookingRef) {
    const path =
      this.client.authMode === "pfs"
        ? `/api/bookings/${supplierBookingRef}/cancel`
        : `/developers/api/v1/flights/bookings/${supplierBookingRef}/cancel`; // UNVERIFIED, same convention caveat as getOffer
    const data = await this.client.request("POST", path);
    return { status: data.status, raw: data };
  }
}

function normalizeOffer(raw) {
  // Maps LetsFG's raw offer shape into TAPI's canonical, supplier-neutral
  // offer model (T-044). Field names on the LetsFG side are best-effort from
  // public docs/samples — adjust against real sandbox responses (T-063).
  return {
    supplierOfferRef: raw.offer_id || raw.id,
    airline: raw.airline || raw.carrier,
    price: raw.price,
    currency: raw.currency || "USD",
    outbound: raw.outbound,
    inbound: raw.inbound || null,
    stops: raw.stops,
    baggage: raw.baggage || null,
    expiresAt: raw.expires_at,
    fareConditions: raw.fare_conditions || null,
  };
}

module.exports = { LetsFGAdapter };
