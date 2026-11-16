// Default TokenBucketStore implementation — this is the exact same
// token-bucket logic rateLimiter.js had inline before Sprint 3, just moved
// behind the TokenBucketStore interface so it's swappable. Behavior is
// UNCHANGED: same refill math, same Map-based storage, same single-instance
// limitation (documented on the interface and in rateLimiter.js) — this is
// a refactor for testability/swappability, not a functional change.
const { TokenBucketStore } = require("../tokenBucketStore.interface");

class InMemoryTokenBucketStore extends TokenBucketStore {
  constructor() {
    super();
    this.buckets = new Map();
  }

  async takeToken(key, { capacity, refillPerSecond }) {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, lastRefill: now };
      this.buckets.set(key, bucket);
    }
    const elapsedSeconds = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSeconds * refillPerSecond);
    bucket.lastRefill = now;

    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  reset() {
    this.buckets.clear();
  }
}

module.exports = { InMemoryTokenBucketStore };
