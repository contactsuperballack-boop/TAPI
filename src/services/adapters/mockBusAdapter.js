const { v4: uuid } = require("uuid");
const { BusSupplier } = require("../busSupplier.interface");

/**
 * Local/dev adapter. It is intentionally deterministic and provider-neutral;
 * replace it with a real operator/aggregator adapter without changing routes.
 */
class MockBusAdapter extends BusSupplier {
  constructor() {
    super();
    this.searches = new Map();
    this.offers = new Map();
    this.bookings = new Map();
  }

  async search(criteria) {
    const ref = `mock_bus_search_${uuid()}`;
    const offerRef = `mock_bus_offer_${uuid()}`;
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    const offer = {
      supplierOfferRef: offerRef,
      operator: "TAPI Demo Coach",
      busName: "TAPI Express",
      busType: criteria.busType || "standard",
      origin: criteria.origin,
      destination: criteria.destination,
      departDate: criteria.departDate,
      departureTime: criteria.departureTime || "08:00",
      arrivalTime: criteria.arrivalTime || "14:00",
      durationMinutes: criteria.durationMinutes || 360,
      seatsAvailable: 32,
      amenities: ["air_conditioning", "reclining_seats"],
      price: 25,
      currency: criteria.currency || "USD",
      expiresAt,
    };
    this.offers.set(offerRef, offer);
    this.searches.set(ref, { status: "completed", offers: [offer] });
    return { supplierSearchRef: ref };
  }

  async pollSearch(supplierSearchRef) {
    return this.searches.get(supplierSearchRef) || { status: "failed", offers: [] };
  }

  async getOffer(supplierOfferRef) {
    return this.offers.get(supplierOfferRef) || null;
  }

  async validateOffer(supplierOfferRef) {
    const offer = this.offers.get(supplierOfferRef);
    return offer ? { valid: offer.seatsAvailable > 0, offer } : { valid: false, offer: null };
  }

  async book(supplierOfferRef, passengers, contact, tripDetails) {
    const offer = this.offers.get(supplierOfferRef);
    if (!offer || offer.seatsAvailable < passengers.length) {
      const err = new Error("Bus offer is unavailable or has insufficient seats");
      err.status = 409;
      err.code = "OFFER_UNAVAILABLE";
      throw err;
    }
    offer.seatsAvailable -= passengers.length;
    const supplierBookingRef = `MOCK-BUS-${uuid().slice(0, 8).toUpperCase()}`;
    const seatNumbers = Array.from({ length: passengers.length }, (_, i) => 32 - offer.seatsAvailable - passengers.length + i + 1);
    const booking = { supplierBookingRef, status: "confirmed", seatNumbers, passengers, contact, tripDetails };
    this.bookings.set(supplierBookingRef, booking);
    return { status: "confirmed", supplierBookingRef, confirmationNumber: supplierBookingRef, seatNumbers, raw: booking };
  }

  async getBooking(supplierBookingRef) {
    const booking = this.bookings.get(supplierBookingRef);
    return booking || { status: "failed" };
  }

  async cancel(supplierBookingRef) {
    const booking = this.bookings.get(supplierBookingRef);
    if (!booking) return { status: "failed" };
    booking.status = "cancelled";
    return { status: "cancelled" };
  }
}

module.exports = { MockBusAdapter };
