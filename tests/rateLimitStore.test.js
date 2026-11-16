// Unit tests for the Sprint 3 rate-limit store abstraction. DB-free, same
// as tests/circuitBreaker.test.js — run anywhere, no TEST_DATABASE_URL.
//
// Run: npx jest tests/rateLimitStore.test.js

const { InMemoryTokenBucketStore } = require("../src/services/rateLimitStores/inMemoryTokenBucketStore");

describe("InMemoryTokenBucketStore", () => {
  test("allows up to `capacity` requests, then blocks", async () => {
    const store = new InMemoryTokenBucketStore();
    const opts = { capacity: 3, refillPerSecond: 0 }; // no refill during the test
    expect(await store.takeToken("k", opts)).toBe(true);
    expect(await store.takeToken("k", opts)).toBe(true);
    expect(await store.takeToken("k", opts)).toBe(true);
    expect(await store.takeToken("k", opts)).toBe(false);
  });

  test("different keys have independent buckets", async () => {
    const store = new InMemoryTokenBucketStore();
    const opts = { capacity: 1, refillPerSecond: 0 };
    expect(await store.takeToken("a", opts)).toBe(true);
    expect(await store.takeToken("b", opts)).toBe(true); // independent bucket, not exhausted by "a"
    expect(await store.takeToken("a", opts)).toBe(false);
  });

  test("refills over time up to capacity", async () => {
    jest.useFakeTimers();
    try {
      const store = new InMemoryTokenBucketStore();
      const opts = { capacity: 2, refillPerSecond: 1 };
      expect(await store.takeToken("k", opts)).toBe(true);
      expect(await store.takeToken("k", opts)).toBe(true);
      expect(await store.takeToken("k", opts)).toBe(false); // exhausted

      jest.setSystemTime(Date.now() + 1500); // ~1.5 tokens refilled
      expect(await store.takeToken("k", opts)).toBe(true);
      expect(await store.takeToken("k", opts)).toBe(false); // only ~1 was available, not 2
    } finally {
      jest.useRealTimers();
    }
  });

  test("reset() clears all bucket state", async () => {
    const store = new InMemoryTokenBucketStore();
    const opts = { capacity: 1, refillPerSecond: 0 };
    await store.takeToken("k", opts);
    expect(await store.takeToken("k", opts)).toBe(false);
    store.reset();
    expect(await store.takeToken("k", opts)).toBe(true);
  });
});

describe("createTokenBucketStore factory", () => {
  // Each case needs a fresh require with a different env var, since the
  // factory reads process.env.RATE_LIMIT_STORE once, at call time.
  afterEach(() => {
    delete process.env.RATE_LIMIT_STORE;
    jest.resetModules();
  });

  test("defaults to in-memory when RATE_LIMIT_STORE is unset", () => {
    jest.resetModules();
    const { createTokenBucketStore } = require("../src/services/rateLimitStores/factory");
    const { InMemoryTokenBucketStore: FreshInMemory } = require("../src/services/rateLimitStores/inMemoryTokenBucketStore");
    expect(createTokenBucketStore()).toBeInstanceOf(FreshInMemory);
  });

  test("RATE_LIMIT_STORE=memory explicitly selects in-memory", () => {
    process.env.RATE_LIMIT_STORE = "memory";
    jest.resetModules();
    const { createTokenBucketStore } = require("../src/services/rateLimitStores/factory");
    expect(() => createTokenBucketStore()).not.toThrow();
  });

  test("RATE_LIMIT_STORE=redis fails fast with a clear, actionable error (not implemented, not silently ignored)", () => {
    process.env.RATE_LIMIT_STORE = "redis";
    jest.resetModules();
    const { createTokenBucketStore } = require("../src/services/rateLimitStores/factory");
    expect(() => createTokenBucketStore()).toThrow(/not implemented yet/i);
  });

  test("an unrecognized RATE_LIMIT_STORE value fails fast rather than silently defaulting", () => {
    process.env.RATE_LIMIT_STORE = "some-typo";
    jest.resetModules();
    const { createTokenBucketStore } = require("../src/services/rateLimitStores/factory");
    expect(() => createTokenBucketStore()).toThrow(/Unknown RATE_LIMIT_STORE/);
  });
});
