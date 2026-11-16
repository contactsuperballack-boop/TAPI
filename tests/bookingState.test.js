const { mapBookingState, classifyBookingFailure } = require("../src/domain/bookingState");

describe("mapBookingState", () => {
  test("a reference always wins, regardless of status string", () => {
    expect(mapBookingState({ rawStatus: "pending", reference: "PNR1" })).toBe("confirmed");
    expect(mapBookingState({ rawStatus: "processing", reference: "X" })).toBe("confirmed");
  });

  test("checkout URL with no reference -> action_required", () => {
    expect(mapBookingState({ checkoutUrl: "https://airline.example/pay" })).toBe("action_required");
  });

  test("reference takes precedence over checkoutUrl if somehow both are present", () => {
    expect(mapBookingState({ reference: "PNR1", checkoutUrl: "https://x" })).toBe("confirmed");
  });

  test.each([
    ["confirmed", "confirmed"],
    ["booked", "confirmed"],
    ["success", "confirmed"],
    ["succeeded", "confirmed"],
    ["SUCCESS", "confirmed"],
    ["failed", "failed"],
    ["error", "failed"],
    ["rejected", "failed"],
    ["checkout_required", "action_required"],
    ["checkout-required", "action_required"],
    ["action_required", "action_required"],
    ["price_changed", "price_changed"],
    ["repriced", "price_changed"],
    ["price changed", "price_changed"],
    ["cancelled", "cancelled"],
    ["canceled", "cancelled"],
  ])("status '%s' maps to '%s'", (raw, expected) => {
    expect(mapBookingState({ rawStatus: raw })).toBe(expected);
  });

  test("unrecognized status defaults to pending, never assumed confirmed", () => {
    expect(mapBookingState({ rawStatus: "something_weird" })).toBe("pending");
    expect(mapBookingState({ rawStatus: "processing" })).toBe("pending");
    expect(mapBookingState({})).toBe("pending");
  });
});

describe("classifyBookingFailure", () => {
  test("ambiguous supplier errors (timeout, unavailable) -> reconciliation_required, not failed", () => {
    expect(classifyBookingFailure({ code: "SUPPLIER_TIMEOUT" })).toBe("reconciliation_required");
    expect(classifyBookingFailure({ code: "SUPPLIER_UNAVAILABLE" })).toBe("reconciliation_required");
  });

  test("conclusive errors -> failed", () => {
    expect(classifyBookingFailure({ code: "VALIDATION_FAILED" })).toBe("failed");
    expect(classifyBookingFailure(new Error("something else"))).toBe("failed");
    expect(classifyBookingFailure({})).toBe("failed");
    expect(classifyBookingFailure(null)).toBe("failed");
  });
});
