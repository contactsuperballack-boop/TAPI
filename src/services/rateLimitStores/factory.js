// Selects which TokenBucketStore implementation rateLimiter.js uses.
// Defaults to InMemoryTokenBucketStore (today's only real implementation).
//
// RATE_LIMIT_STORE=redis is accepted as a value but deliberately NOT
// implemented here — no Redis client is in package.json and there's no
// network in this sandbox to add one, let alone verify it against a real
// Redis instance. Rather than ship a fake/untested "implementation" that
// would silently behave like nothing, or silently fall back to in-memory
// and mask a real ops misconfiguration, selecting 'redis' today throws a
// clear, fail-at-startup error explaining exactly what's missing. This
// matches the honesty standard the rest of this codebase holds itself to
// (see supplierRegistry.js, GO_LIVE_CHECKLIST.md) rather than quietly
// degrading rate-limit guarantees under real traffic.
//
// Deliberately evaluated ONCE at module load (not lazily per-request, unlike
// supplierRegistry.js's suppliers) — every /v1 request depends on rate
// limiting, so a misconfigured RATE_LIMIT_STORE should crash startup
// immediately and visibly, not surface as a confusing failure on whichever
// request happens to hit it first.
const { InMemoryTokenBucketStore } = require("./inMemoryTokenBucketStore");

function createTokenBucketStore() {
  const backend = process.env.RATE_LIMIT_STORE || "memory";
  if (backend === "memory") {
    return new InMemoryTokenBucketStore();
  }
  if (backend === "redis") {
    throw new Error(
      "RATE_LIMIT_STORE=redis is not implemented yet. This is the documented seam for it " +
        "(TokenBucketStore interface + rateLimitStores/ directory) but no Redis client has been " +
        "added to package.json or verified against a real instance. Implement " +
        "rateLimitStores/redisTokenBucketStore.js against the TokenBucketStore interface " +
        "(src/services/tokenBucketStore.interface.js) — the atomicity note on takeToken() there " +
        "matters: use a Lua script or equivalent, not a separate read+write, or concurrent " +
        "requests can both succeed past a bucket that should have blocked the second one. " +
        "Set RATE_LIMIT_STORE=memory (or unset it) to run with the current single-instance store."
    );
  }
  throw new Error(`Unknown RATE_LIMIT_STORE '${backend}'. Supported: 'memory' (default), 'redis' (not yet implemented — see error above).`);
}

module.exports = { createTokenBucketStore };
