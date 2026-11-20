// Tiqwa flight adapter — SCAFFOLD ONLY. No live Tiqwa call is made anywhere in
// this file, and nothing here has been verified against Tiqwa's real API.
//
// Tiqwa (tiqwa.com) is a candidate regional/GDS-aggregator supplier (Amadeus +
// consolidator inventory, African carriers, SOTO fares). The claims below come
// from an unverified product assessment, NOT from Tiqwa's documentation or a
// sandbox run, and must be confirmed before any method is implemented:
//   - sandbox base URL (assumed https://sandbox.tiqwa.com/v1)
//   - auth scheme, rate limits, search/price/reserve/ticket endpoints
//   - whether reservation and ticketing are separate calls, and the ticketing
//     time limit (TTL) on a held PNR
//   - passenger document schema (number, issuing_date, expiry_date,
//     issuing_country, nationality_country)
//   - settlement / who-pays-the-supplier model, commission and markup terms
//
// The capabilities below describe the INTENDED GDS shape so the rest of TAPI
// (state machine, poller, routes) is already ready for it:
//   * asyncBooking + reserveThenTicket: book() creates a held reservation; the
//     booking sits in 'ticketing_pending' until a ticket number exists.
//   * 'confirmed' is only ever reached with ticket evidence (see liveBookingState).
//
// To make this real: Product Owner decision gate (commercial terms), sandbox
// credentials, search coverage tests, booking lifecycle tests, THEN implement,
// replacing NOT_READY one method at a time and updating capabilities to match.
const { FlightSupplier } = require("../flightSupplier.interface");

const NOT_READY = (method) => () => {
  throw new Error(`TiqwaAdapter.${method}() is not implemented: this is a scaffold. Tiqwa's API has not been verified or contracted.`);
};

class TiqwaAdapter extends FlightSupplier {
  constructor(config = {}) {
    super();
    this.config = { baseUrl: config.baseUrl || "https://sandbox.tiqwa.com/v1", ...config }; // baseUrl unverified
  }

  get capabilities() {
    return {
      asyncBooking: true,
      reserveThenTicket: true,
      supportsAnswer: false,
      supportsStop: false,
      supportsCancel: false,
      offerValidation: "explicit", // GDS fares must be re-priced before reservation
      sandbox: true,               // scaffold defaults to sandbox until proven otherwise
      lookupByKey: false,          // unverified; flip only if Tiqwa guarantees an authoritative lookup
    };
  }

  resolveLocation = NOT_READY("resolveLocation");
  search = NOT_READY("search");
  pollSearch = NOT_READY("pollSearch");
  getOffer = NOT_READY("getOffer");
  validateOffer = NOT_READY("validateOffer");
  book = NOT_READY("book");
  getBooking = NOT_READY("getBooking");
  cancel = NOT_READY("cancel");
}

module.exports = { TiqwaAdapter };
