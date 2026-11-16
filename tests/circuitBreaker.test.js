// Unit tests for domain/circuitBreaker.js. Deliberately requires NO
// TEST_DATABASE_URL and no network — this is pure in-memory logic, so
// unlike the rest of this suite it can run in any environment, including
// one with no Postgres or outbound network access at all.
//
// Run: npx jest tests/circuitBreaker.test.js  (no TEST_DATABASE_URL needed)

const { CircuitBreaker } = require("../src/domain/circuitBreaker");

describe("CircuitBreaker", () => {
  test("stays closed and passes results through while calls succeed", async () => {
    const breaker = new CircuitBreaker({ name: "test", failureThreshold: 3, cooldownMs: 1000 });
    const result = await breaker.execute(async () => "ok");
    expect(result).toBe("ok");
    expect(breaker.getStatus()).toEqual({ name: "test", state: "closed", consecutiveFailures: 0 });
  });

  test("opens after reaching the failure threshold, then fails fast without calling fn", async () => {
    const breaker = new CircuitBreaker({ name: "test", failureThreshold: 3, cooldownMs: 60_000 });
    const failing = jest.fn(async () => {
      throw new Error("supplier down");
    });

    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(failing)).rejects.toThrow("supplier down");
    }
    expect(breaker.getStatus().state).toBe("open");
    expect(failing).toHaveBeenCalledTimes(3);

    // Circuit is open — next call must fail fast (a distinct error) WITHOUT
    // invoking fn again, and the fast-fail error must be catchable as a
    // structured ApiError (SUPPLIER_UNAVAILABLE), same as a real failed call.
    await expect(breaker.execute(failing)).rejects.toMatchObject({ code: "SUPPLIER_UNAVAILABLE" });
    expect(failing).toHaveBeenCalledTimes(3); // still 3 — the 4th call never reached fn
  });

  test("a single failure below the threshold does not open the circuit", async () => {
    const breaker = new CircuitBreaker({ name: "test", failureThreshold: 3, cooldownMs: 1000 });
    await expect(breaker.execute(async () => { throw new Error("one-off"); })).rejects.toThrow("one-off");
    expect(breaker.getStatus().state).toBe("closed");
  });

  test("a success resets the consecutive-failure count", async () => {
    const breaker = new CircuitBreaker({ name: "test", failureThreshold: 3, cooldownMs: 1000 });
    await expect(breaker.execute(async () => { throw new Error("fail 1"); })).rejects.toThrow();
    await expect(breaker.execute(async () => { throw new Error("fail 2"); })).rejects.toThrow();
    await breaker.execute(async () => "recovered");
    expect(breaker.getStatus()).toEqual({ name: "test", state: "closed", consecutiveFailures: 0 });

    // Two more failures now shouldn't open it either — the count was reset,
    // not just decremented.
    await expect(breaker.execute(async () => { throw new Error("fail 3"); })).rejects.toThrow();
    await expect(breaker.execute(async () => { throw new Error("fail 4"); })).rejects.toThrow();
    expect(breaker.getStatus().state).toBe("closed");
  });

  test("allows a trial request after the cooldown elapses, and closes on success", async () => {
    jest.useFakeTimers();
    try {
      const breaker = new CircuitBreaker({ name: "test", failureThreshold: 1, cooldownMs: 5000 });
      await expect(breaker.execute(async () => { throw new Error("down"); })).rejects.toThrow("down");
      expect(breaker.getStatus().state).toBe("open");

      // Still within cooldown — fails fast.
      await expect(breaker.execute(async () => "should not run")).rejects.toMatchObject({ code: "SUPPLIER_UNAVAILABLE" });

      // Advance past the cooldown window.
      jest.advanceTimersByTime(5001);

      const result = await breaker.execute(async () => "recovered");
      expect(result).toBe("recovered");
      expect(breaker.getStatus().state).toBe("closed");
    } finally {
      jest.useRealTimers();
    }
  });

  test("a failed trial request during cooldown stays open and restarts the cooldown clock", async () => {
    jest.useFakeTimers();
    try {
      const breaker = new CircuitBreaker({ name: "test", failureThreshold: 1, cooldownMs: 5000 });
      await expect(breaker.execute(async () => { throw new Error("down"); })).rejects.toThrow();
      jest.advanceTimersByTime(5001);

      // Trial request also fails — circuit must stay open.
      await expect(breaker.execute(async () => { throw new Error("still down"); })).rejects.toThrow("still down");
      expect(breaker.getStatus().state).toBe("open");

      // Immediately after that failed trial, still within the RESTARTED
      // cooldown — must fail fast again, not allow another trial yet.
      await expect(breaker.execute(async () => "should not run")).rejects.toMatchObject({ code: "SUPPLIER_UNAVAILABLE" });
    } finally {
      jest.useRealTimers();
    }
  });
});
