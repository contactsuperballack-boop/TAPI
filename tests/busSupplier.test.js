const { MockBusAdapter } = require("../src/services/adapters/mockBusAdapter");

describe("Mock bus supplier", () => {
  test("searches, validates, books seats, retrieves, and cancels", async () => {
    const supplier = new MockBusAdapter();
    const { supplierSearchRef } = await supplier.search({ origin: "Lagos", destination: "Abuja", departDate: "2026-12-01", passengers: 2 });
    const result = await supplier.pollSearch(supplierSearchRef);
    expect(result.status).toBe("completed");
    expect(result.offers).toHaveLength(1);

    const offer = result.offers[0];
    expect((await supplier.validateOffer(offer.supplierOfferRef)).valid).toBe(true);
    const booking = await supplier.book(offer.supplierOfferRef, [{ firstName: "A", lastName: "B" }, { firstName: "C", lastName: "D" }], { email: "test@example.com" }, {});
    expect(booking.status).toBe("confirmed");
    expect(booking.seatNumbers).toHaveLength(2);
    expect((await supplier.getBooking(booking.supplierBookingRef)).status).toBe("confirmed");
    expect((await supplier.cancel(booking.supplierBookingRef)).status).toBe("cancelled");
  });
});
