// Contract every hotel supplier adapter must implement (Backlog T-031,
// Master Spec §5). Mirrors FlightSupplier's shape deliberately so the
// domain/route layer treats both product types consistently.
class HotelSupplier {
  /** @returns {Promise<Array<{id:string,name:string,city:string,country:string}>>} */
  async resolveDestination(query) { throw new Error("not implemented"); }

  /** Kick off an async search. @returns {Promise<{supplierSearchRef:string}>} */
  async search(criteria) { throw new Error("not implemented"); }

  async pollSearch(supplierSearchRef) { throw new Error("not implemented"); }

  async getOffer(supplierOfferRef) { throw new Error("not implemented"); }

  /** Recheck a rate before booking — some suppliers require this (rate_type=RECHECK). */
  async validateOffer(supplierOfferRef) { throw new Error("not implemented"); }

  /** Async booking. @returns {Promise<{supplierJobRef:string}>} — poll getBooking(). */
  async book(supplierOfferRef, guests, contact) { throw new Error("not implemented"); }

  async getBooking(supplierBookingRef) { throw new Error("not implemented"); }

  async cancel(supplierBookingRef) { throw new Error("not implemented"); }
}

module.exports = { HotelSupplier };
