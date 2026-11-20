// Contract every flight supplier adapter must implement. The domain layer,
// API routes, CLI, worker and MCP only ever call this interface — never a
// supplier SDK directly. Differences between suppliers are declared in
// `capabilities`, not discovered by checking supplier names in route code.
//
// Optional methods (only called when the matching capability is true):
//   answer(supplierBookingRef, answer)  — capabilities.supportsAnswer
//   stop(supplierBookingRef)            — capabilities.supportsStop
//   findBookingByKey(idempotencyKey)    — capabilities.lookupByKey (authoritative lookup; see DEFAULT_CAPABILITIES)
//
// getBooking() MUST return a normalised `state`:
//   'in_progress' | 'ticketing_pending' | 'confirmed' | 'failed' | 'needs_attention'
// plus `pnr` (evidence reference, null until real), and may return the supplier's raw status.

const OFFER_VALIDATION_MODES = ["explicit", "at-booking", "none"];

const DEFAULT_CAPABILITIES = Object.freeze({
  asyncBooking: false,       // book() only ACCEPTS; final result arrives later via getBooking()
  reserveThenTicket: false,  // a PNR can exist before a ticket is issued (GDS-style)
  supportsAnswer: false,
  supportsStop: false,
  supportsCancel: false,
  offerValidation: "none",   // 'explicit' = validateOffer() works; 'at-booking' = supplier checks while booking
  sandbox: false,            // adapter is currently pointed at a sandbox
  // true ONLY if the supplier guarantees findBookingByKey() is authoritative: it returns the booking created with
  // that idempotency key if one exists, and null ONLY if no such booking was ever created. Unverified => false.
  lookupByKey: false,
});

class FlightSupplier {
  get capabilities() { return DEFAULT_CAPABILITIES; }

  /** @returns {Promise<Array<{code:string,name:string,city:string,country:string}>>} */
  async resolveLocation(query) { throw new Error("not implemented"); }

  /** Kick off an async search. @returns {Promise<{supplierSearchRef:string}>} */
  async search(criteria) { throw new Error("not implemented"); }

  /** Poll a previously started search. @returns {Promise<{status:'processing'|'completed'|'failed', offers:Array}>} */
  async pollSearch(supplierSearchRef) { throw new Error("not implemented"); }

  async getOffer(supplierOfferRef) { throw new Error("not implemented"); }

  /** Reprice/confirm offer is still bookable (when capabilities.offerValidation === 'explicit'). */
  async validateOffer(supplierOfferRef) { throw new Error("not implemented"); }

  /**
   * @param {string} supplierOfferRef
   * @param {Array} passengers
   * @param {{email:string}} contact
   * @param {{supplierSearchId?:string, idempotencyKey?:string, wantSeat?:boolean, sandboxScenario?:string, sandboxSpeed?:string}} [context]
   */
  async book(supplierOfferRef, passengers, contact, context = {}) { throw new Error("not implemented"); }

  async getBooking(supplierBookingRef) { throw new Error("not implemented"); }

  async cancel(supplierBookingRef) { throw new Error("not implemented"); }

  // Optional (capabilities.lookupByKey): find a booking by the idempotency key it was submitted with.
  // @returns {Promise<{supplierBookingRef:string}|null>}
}

const REQUIRED_METHODS = ["resolveLocation", "search", "pollSearch", "getOffer", "validateOffer", "book", "getBooking", "cancel"];

/** Throws if `adapter` does not honour the contract. Used by the registry and by the contract test. */
function assertFlightSupplier(adapter, label = "supplier") {
  const problems = [];
  for (const m of REQUIRED_METHODS) if (typeof adapter[m] !== "function") problems.push(`missing method ${m}()`);
  const caps = adapter.capabilities;
  if (!caps || typeof caps !== "object") problems.push("missing capabilities");
  else {
    for (const k of Object.keys(DEFAULT_CAPABILITIES)) if (!(k in caps)) problems.push(`capabilities.${k} not declared`);
    if (!OFFER_VALIDATION_MODES.includes(caps.offerValidation)) problems.push(`capabilities.offerValidation must be one of ${OFFER_VALIDATION_MODES.join("|")}`);
    if (caps.supportsAnswer && typeof adapter.answer !== "function") problems.push("supportsAnswer=true but answer() missing");
    if (caps.supportsStop && typeof adapter.stop !== "function") problems.push("supportsStop=true but stop() missing");
    if (caps.lookupByKey && typeof adapter.findBookingByKey !== "function") problems.push("lookupByKey=true but findBookingByKey() missing");
  }
  if (problems.length) throw new Error(`${label} violates FlightSupplier contract: ${problems.join("; ")}`);
  return adapter;
}

module.exports = { FlightSupplier, DEFAULT_CAPABILITIES, REQUIRED_METHODS, OFFER_VALIDATION_MODES, assertFlightSupplier };
