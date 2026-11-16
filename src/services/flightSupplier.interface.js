// Contract every flight supplier adapter must implement (Backlog T-030,
// Master Spec §5). The domain layer, API routes, CLI and (eventually) MCP
// only ever call this interface — never a supplier SDK directly.
class FlightSupplier {
  /** @returns {Promise<Array<{code:string,name:string,city:string,country:string}>>} */
  async resolveLocation(query) { throw new Error("not implemented"); }

  /** Kick off an async search. @returns {Promise<{supplierSearchRef:string}>} */
  async search(criteria) { throw new Error("not implemented"); }

  /** Poll a previously started search. @returns {Promise<{status:'processing'|'completed'|'failed', offers:Array}>} */
  async pollSearch(supplierSearchRef) { throw new Error("not implemented"); }

  async getOffer(supplierOfferRef) { throw new Error("not implemented"); }

  /** Reprice/confirm offer is still bookable. Some suppliers require this before book(). */
  async validateOffer(supplierOfferRef) { throw new Error("not implemented"); }

  async book(supplierOfferRef, passengers, contact) { throw new Error("not implemented"); }

  async getBooking(supplierBookingRef) { throw new Error("not implemented"); }

  async cancel(supplierBookingRef) { throw new Error("not implemented"); }
}

module.exports = { FlightSupplier };
