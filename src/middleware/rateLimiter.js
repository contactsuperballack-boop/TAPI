// Token-bucket rate limiting (T-025).
//
// Sprint 3 hardening: the token-bucket storage itself (previously an inline
// module-level Map here) has been extracted behind the TokenBucketStore
// interface (src/services/tokenBucketStore.interface.js) — this file now
// only owns the rate-limiting POLICY (bucket naming, keying by
// tenant/IP, the 429 response shape), not where bucket state lives. That
// was always the actual limitation described below: in-memory, single-
// instance only. Swapping to a shared store for multi-instance deployments
// is now a matter of implementing rateLimitStores/redisTokenBucketStore.js
// against the interface and setting RATE_LIMIT_STORE=redis — no change
// needed here or in app.js. See rateLimitStores/factory.js for exactly
// what's real today (in-memory) vs. seamed-but-not-built (redis).
const { createTokenBucketStore } = require("../services/rateLimitStores/factory");

const store = createTokenBucketStore();

// Fix for a confirmed test-environment problem: dozens of booking/order
// test cases hitting the same tenant within one test file exhausted real
// limits (e.g. orders: capacity 20) partway through a suite, so LATER tests
// got 429 instead of the validation/business-logic response they were
// actually asserting on — a test-harness problem masquerading as a product
// bug. DISABLE_RATE_LIMIT=true removes rate limiting entirely for test
// runs; resetBuckets() is available for suites that want to verify
// rate-limiting behavior specifically without disabling it globally.
function resetBuckets() {
  store.reset();
}

/**
 * Rate limit middleware factory.
 * @param {object} opts
 * @param {string} opts.name - unique name for this limiter instance, namespaces its buckets
 *   so two limiters with different capacities don't collide on the same tenant/IP key
 * @param {number} opts.capacity - max burst size
 * @param {number} opts.refillPerSecond - steady-state requests/sec allowed
 * @param {(req) => string} opts.keyFn - how to bucket requests (per-tenant, per-IP, etc.)
 */
function rateLimit({ name, capacity, refillPerSecond, keyFn }) {
  return async (req, res, next) => {
    if (process.env.DISABLE_RATE_LIMIT === "true") return next();

    const key = `${name}:${keyFn(req)}`;
    let allowed;
    try {
      allowed = await store.takeToken(key, { capacity, refillPerSecond });
    } catch (err) {
      // A store failure (e.g. a future Redis implementation losing its
      // connection) should not silently let every request through
      // unlimited, but it also shouldn't take the whole API down over a
      // rate-limiter outage. Fail closed with a clear 503 rather than
      // either extreme.
      return next(err);
    }
    if (!allowed) {
      return res.status(429).type("application/problem+json").json({
        type: "https://tapi.dev/errors/rate_limited",
        title: "Rate limit exceeded",
        status: 429,
        detail: "Too many requests. Slow down and retry after a short delay.",
        instance: req.originalUrl,
        timestamp: new Date().toISOString(),
        code: "RATE_LIMITED",
      });
    }
    next();
  };
}

// Tenant-scoped limiter for authenticated, expensive operations (search,
// booking). Applied AFTER `authenticate`, so req.tenant is available.
const perTenantLimiter = (opts) =>
  rateLimit({ ...opts, keyFn: (req) => req.tenant?.agencyId || "unknown" });

// Per-IP limiter for unauthenticated attempts (auth failures, brute-force
// key guessing). Applied on every request BEFORE `authenticate` runs, so it
// can't be bypassed by cycling through invalid keys.
const perIpLimiter = (opts) =>
  rateLimit({ ...opts, keyFn: (req) => req.ip });

module.exports = { rateLimit, perTenantLimiter, perIpLimiter, resetBuckets };
