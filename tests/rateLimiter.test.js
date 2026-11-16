// Unit tests for middleware/rateLimiter.js's policy layer (bucket naming,
// tenant/IP keying, 429 shape, DISABLE_RATE_LIMIT bypass). The storage layer
// itself is covered separately in tests/rateLimitStore.test.js. DB-free —
// this middleware has no DB dependency.
//
// Run: npx jest tests/rateLimiter.test.js

const { rateLimit, perTenantLimiter, perIpLimiter, resetBuckets } = require("../src/middleware/rateLimiter");

function fakeReqRes({ ip = "1.2.3.4", agencyId } = {}) {
  const req = { ip, originalUrl: "/v1/test", tenant: agencyId ? { agencyId } : undefined };
  const res = {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    type() { return this; },
    json(b) { this.body = b; return this; },
  };
  return { req, res };
}

beforeEach(() => {
  resetBuckets();
  delete process.env.DISABLE_RATE_LIMIT;
});

describe("rateLimit middleware", () => {
  test("allows up to capacity requests then returns 429 with the documented error shape", async () => {
    const mw = rateLimit({ name: "t1", capacity: 2, refillPerSecond: 0, keyFn: (r) => r.ip });
    let nextCalls = 0;
    const next = () => nextCalls++;
    const { req, res } = fakeReqRes();

    await mw(req, res, next);
    await mw(req, res, next);
    await mw(req, res, next); // blocked

    expect(nextCalls).toBe(2);
    expect(res.statusCode).toBe(429);
    expect(res.body.code).toBe("RATE_LIMITED");
    expect(res.body.status).toBe(429);
  });

  test("DISABLE_RATE_LIMIT=true bypasses limiting entirely, even past capacity", async () => {
    process.env.DISABLE_RATE_LIMIT = "true";
    const mw = rateLimit({ name: "t2", capacity: 1, refillPerSecond: 0, keyFn: (r) => r.ip });
    let nextCalls = 0;
    const next = () => nextCalls++;
    const { req, res } = fakeReqRes();

    for (let i = 0; i < 5; i++) await mw(req, res, next);
    expect(nextCalls).toBe(5);
    expect(res.statusCode).toBeNull();
  });

  test("two different limiter names don't share buckets even for the same key", async () => {
    const mwA = rateLimit({ name: "a", capacity: 1, refillPerSecond: 0, keyFn: (r) => r.ip });
    const mwB = rateLimit({ name: "b", capacity: 1, refillPerSecond: 0, keyFn: (r) => r.ip });
    const { req, res } = fakeReqRes();
    let calls = 0;
    const next = () => calls++;

    await mwA(req, res, next); // consumes limiter "a"'s bucket for this IP
    await mwB(req, res, next); // limiter "b" is untouched, should still succeed
    expect(calls).toBe(2);
  });
});

describe("perTenantLimiter / perIpLimiter keying", () => {
  test("perTenantLimiter keys by agencyId, isolating tenants from each other", async () => {
    const mw = perTenantLimiter({ name: "tenant-scoped", capacity: 1, refillPerSecond: 0 });
    let calls = 0;
    const next = () => calls++;

    const { req: reqA, res: resA } = fakeReqRes({ agencyId: "agency-a" });
    const { req: reqB, res: resB } = fakeReqRes({ agencyId: "agency-b" });

    await mw(reqA, resA, next);
    await mw(reqB, resB, next); // different tenant — independent bucket
    await mw(reqA, resA, next); // agency-a's second request — blocked

    expect(calls).toBe(2);
    expect(resA.statusCode).toBe(429);
    expect(resB.statusCode).toBeNull();
  });

  test("perIpLimiter keys by IP regardless of tenant", async () => {
    const mw = perIpLimiter({ name: "ip-scoped", capacity: 1, refillPerSecond: 0 });
    let calls = 0;
    const next = () => calls++;

    const { req: req1, res: res1 } = fakeReqRes({ ip: "9.9.9.9", agencyId: "agency-a" });
    const { req: req2, res: res2 } = fakeReqRes({ ip: "9.9.9.9", agencyId: "agency-b" });

    await mw(req1, res1, next); // same IP, different tenant
    await mw(req2, res2, next); // still blocked — perIpLimiter doesn't care about tenant

    expect(calls).toBe(1);
    expect(res2.statusCode).toBe(429);
  });
});
