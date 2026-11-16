// Nigerian Domestic Supplier adapter — SCAFFOLD ONLY, not a real integration.
//
// This exists to prove the FlightSupplier interface generalizes to a second
// flight source without route/domain code changes — the actual point of
// EPIC-04 (Supplier Abstraction). It is deliberately non-functional.
//
// Per your own Backlog (EPIC-07): "No route is considered supported from
// documentation alone... Do not proceed on screenshots or claims alone."
// There is no domestic supplier under contract yet — that's an open
// Product Owner Decision Gate item (TAPI Master Product Document §6).
// Every method here throws rather than pretending to work, so a
// misconfiguration can't silently produce fake search results or, worse,
// an attempted real booking against a nonexistent integration.
//
// To make this real, in order:
//   1. Product Owner Decision Gate: which supplier, what commercial terms (T-061)
//   2. Obtain actual sandbox/test API access — not marketing docs (T-062)
//   3. Run search coverage tests against real routes (T-063)
//   4. Run booking tests proving the actual lifecycle (T-064)
//   5. Only then implement this adapter for real (T-065)
//
// See migration 005_domestic_supplier_evaluation.sql for where to track
// progress through steps 1-4 without writing throwaway code for it.

const { FlightSupplier } = require("../flightSupplier.interface");

const NOT_READY = (method) => () => {
  throw new Error(
    `NigerianDomesticAdapter.${method}() called, but no domestic supplier is under contract yet. ` +
      `This is a scaffold proving the FlightSupplier interface, not a working integration. ` +
      `See TAPI Master Product Document §6 (Product Owner Decision Gate) and Backlog EPIC-07/T-060-T-065.`
  );
};

class NigerianDomesticAdapter extends FlightSupplier {
  constructor(config = {}) {
    super();
    this.config = config; // intentionally unused until a real supplier is contracted
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

module.exports = { NigerianDomesticAdapter };
