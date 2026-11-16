const {
  STATES, TRANSITIONS, TERMINAL_STATES,
  assertValidTransition, requiresSupplierReference, isTerminal, InvalidTransitionError,
} = require("../src/domain/bookingStateMachine");

describe("Booking state machine — structural integrity", () => {
  test("every transition target is a real state", () => {
    for (const [from, targets] of Object.entries(TRANSITIONS)) {
      expect(STATES).toContain(from);
      for (const to of targets) expect(STATES).toContain(to);
    }
  });

  test("every state has a TRANSITIONS entry, even terminal ones (empty array)", () => {
    for (const s of STATES) expect(TRANSITIONS).toHaveProperty(s);
  });

  test("every non-terminal state has at least one way out — no accidental dead ends", () => {
    for (const s of STATES) {
      if (!isTerminal(s)) expect(TRANSITIONS[s].length).toBeGreaterThan(0);
    }
  });
});

describe("Booking state machine — transition validation", () => {
  test("legal transitions succeed silently", () => {
    expect(() => assertValidTransition("created", "pending")).not.toThrow();
    expect(() => assertValidTransition("pending", "confirmed")).not.toThrow();
    expect(() => assertValidTransition("confirmed", "cancel_requested")).not.toThrow();
    expect(() => assertValidTransition("cancel_requested", "refund_pending")).not.toThrow();
    expect(() => assertValidTransition("refund_pending", "refunded")).not.toThrow();
    expect(() => assertValidTransition("reconciliation_required", "confirmed")).not.toThrow();
  });

  test("backwards transitions are rejected", () => {
    expect(() => assertValidTransition("confirmed", "pending")).toThrow(InvalidTransitionError);
    expect(() => assertValidTransition("refunded", "confirmed")).toThrow(InvalidTransitionError);
  });

  test("transitions out of terminal states are rejected", () => {
    expect(() => assertValidTransition("failed", "confirmed")).toThrow(InvalidTransitionError);
    expect(() => assertValidTransition("cancelled", "confirmed")).toThrow(InvalidTransitionError);
    expect(() => assertValidTransition("refunded", "refund_pending")).toThrow(InvalidTransitionError);
  });

  test("transitions to an unknown state are rejected", () => {
    expect(() => assertValidTransition("pending", "made_up_status")).toThrow(InvalidTransitionError);
  });

  test("skipping required intermediate states is rejected — confirmed cannot jump straight to refunded", () => {
    expect(() => assertValidTransition("confirmed", "refunded")).toThrow(InvalidTransitionError);
    expect(() => assertValidTransition("confirmed", "cancelled")).toThrow(InvalidTransitionError); // must go through cancel_requested
  });
});

describe("Booking state machine — guard rules", () => {
  test("only 'confirmed' requires a supplier reference", () => {
    expect(requiresSupplierReference("confirmed")).toBe(true);
    expect(requiresSupplierReference("pending")).toBe(false);
    expect(requiresSupplierReference("action_required")).toBe(false);
    expect(requiresSupplierReference("failed")).toBe(false);
  });

  test("terminal states are exactly failed, cancelled, refunded — not reconciliation_required or refund_failed", () => {
    expect([...TERMINAL_STATES].sort()).toEqual(["cancelled", "failed", "refunded"]);
    expect(isTerminal("reconciliation_required")).toBe(false); // must remain escapable — that's the whole point of the state
    expect(isTerminal("refund_failed")).toBe(false); // must be retryable, not a dead end
  });
});
