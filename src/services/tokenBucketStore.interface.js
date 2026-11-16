// Contract a rate-limit token-bucket store must implement. Mirrors the
// pattern this repo already uses for supplier adapters
// (flightSupplier.interface.js, hotelSupplier.interface.js,
// busSupplier.interface.js, paymentProvider.interface.js) — route/middleware
// code depends only on this interface, never on a specific store
// implementation directly.
//
// Sprint 3 hardening: rateLimiter.js's own comments have said since it was
// built that its in-memory bucket Map is "single-instance only... a
// multi-instance deployment needs a shared store (Redis)". This interface is
// that seam — InMemoryTokenBucketStore (default today) and a future
// RedisTokenBucketStore both implement it, and rateLimiter.js only ever
// calls `store.takeToken(...)`. No Redis client is available to actually
// install in this sandbox (no network), so this deliberately stops at "the
// abstraction exists and is swappable" rather than shipping a Redis
// implementation nobody could verify. See rateLimitStore/factory.js for how
// selection works and what happens if RATE_LIMIT_STORE=redis is set today.
class TokenBucketStore {
  /**
   * Attempts to take one token from the named bucket, refilling it first
   * based on elapsed time since its last refill. Must be safe to call
   * concurrently for the same key (a Redis implementation would need this
   * to be a single atomic operation — e.g. a Lua script — not a
   * read-then-write pair, to avoid a race under real concurrent traffic;
   * the in-memory implementation gets this for free from Node's
   * single-threaded event loop, which a Redis version explicitly cannot
   * assume).
   *
   * @param {string} key - fully-namespaced bucket key (limiter name + tenant/IP)
   * @param {{capacity: number, refillPerSecond: number}} opts
   * @returns {Promise<boolean>} true if a token was taken (request allowed), false if none available (rate limited)
   */
  async takeToken(key, opts) {
    throw new Error("TokenBucketStore.takeToken not implemented");
  }

  /** Clears all bucket state. Test-only — see rateLimiter.js's resetBuckets(). */
  reset() {
    throw new Error("TokenBucketStore.reset not implemented");
  }
}

module.exports = { TokenBucketStore };
