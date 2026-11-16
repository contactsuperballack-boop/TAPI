// Provider-neutral contract for bus inventory and reservation suppliers.
// Routes and domain code depend on this interface, never on a supplier SDK.
class BusSupplier {
  async search(criteria) { throw new Error("not implemented"); }
  async pollSearch(supplierSearchRef) { throw new Error("not implemented"); }
  async getOffer(supplierOfferRef) { throw new Error("not implemented"); }
  async validateOffer(supplierOfferRef) { throw new Error("not implemented"); }
  async book(supplierOfferRef, passengers, contact, tripDetails) { throw new Error("not implemented"); }
  async getBooking(supplierBookingRef) { throw new Error("not implemented"); }
  async cancel(supplierBookingRef) { throw new Error("not implemented"); }
}

module.exports = { BusSupplier };
