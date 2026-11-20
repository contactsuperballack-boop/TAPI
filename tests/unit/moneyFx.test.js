// Sprint 10.6 — exact money maths and the FX quote engine. Pure unit tests.
const test = require("node:test");
const assert = require("node:assert/strict");
const { toMinor, fromMinor, allocate } = require("../../src/domain/money");
const fx = require("../../src/domain/fx");
const { StaticFxProvider } = require("../../src/services/fxProvider.interface");
const { createQuote, consumeQuote } = require("../../src/services/fxService");

test("money: exact parsing, no silent rounding, currency exponents", () => {
  assert.equal(toMinor("1234.56", "USD"), 123456);
  assert.equal(toMinor(0.1 + 0.2, "USD"), 30);        // float noise tolerated only below the currency precision
  assert.equal(toMinor("1000", "JPY"), 1000);
  assert.equal(toMinor("1.234", "KWD"), 1234);
  assert.equal(toMinor("12.50", "NGN"), 1250);
  assert.throws(() => toMinor("1.005", "USD"), /more precision/);
  assert.throws(() => toMinor("abc", "USD"), /Invalid money/);
  assert.equal(fromMinor(5, "USD"), "0.05");
  assert.equal(fromMinor(123456, "USD"), "1234.56");
  assert.equal(fromMinor(1000, "JPY"), "1000");
  assert.equal(fromMinor(-250, "USD"), "-2.50");
});

test("money: allocation always sums to the total (property check over many random splits)", () => {
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let i = 0; i < 500; i++) {
    const total = rnd(10_000_000);
    const weights = Array.from({ length: 1 + rnd(6) }, () => 1 + rnd(100000));
    const parts = allocate(total, weights);
    assert.equal(parts.reduce((a, b) => a + b, 0), total, JSON.stringify({ total, weights }));
    assert.ok(parts.every((p) => Number.isInteger(p) && p >= 0));
  }
  assert.deepEqual(allocate(100, [1, 1, 1]), [34, 33, 33]);
  assert.throws(() => allocate(100, [0, 0]), /zero/);
});

const base = { baseCurrency: "USD", quoteCurrency: "NGN", midRate: "1500.5", bufferBps: 100, source: "test" };

test("fx: conversion is exact, includes the buffer, and rounds UP in TAPI's favour", () => {
  const q = fx.buildQuote({ ...base, asOf: new Date() });
  assert.equal(fx.convertUp(q, 10000), 15155050);              // 100.00 USD * 1500.5 * 1.01 = 151,550.50 NGN
  const odd = fx.buildQuote({ ...base, midRate: "1500.3333", bufferBps: 0, asOf: new Date() });
  assert.equal(fx.convertUp(odd, 1), 1501);                    // 0.01 USD = 1500.3333 kobo -> rounds UP to 1501
});

test("fx: rounding up never under-collects (sampled against exact rational)", () => {
  const q = fx.buildQuote({ ...base, midRate: "1499.9999999999", bufferBps: 37, asOf: new Date() });
  for (const amt of [1, 7, 99, 12345, 999999]) {
    const out = fx.convertUp(q, amt);
    const exact = (BigInt(amt) * 14999999999999n * 10037n); // amt * rate*1e10 * (10000+37); the 10^2 exponents cancel (USD and NGN both 2dp)
    const den = 10n ** 10n * 10000n;
    assert.ok(BigInt(out) * den >= exact, `under-collected for ${amt}`);
    assert.ok((BigInt(out) - 1n) * den < exact, `over-collected by more than 1 minor unit for ${amt}`);
  }
});

test("fx: expiry, consumption and currency mismatch are refused with specific codes", () => {
  const now = new Date("2026-11-18T10:00:00Z");
  const q = fx.buildQuote({ ...base, asOf: now, now, ttlMs: 60_000 });
  assert.equal(fx.assertQuoteUsable(q, { now: new Date(now.getTime() + 30_000), baseCurrency: "USD", quoteCurrency: "NGN" }), true);
  assert.throws(() => fx.assertQuoteUsable(q, { now: new Date(now.getTime() + 61_000) }), (e) => e.code === "FX_QUOTE_EXPIRED");
  assert.throws(() => fx.assertQuoteUsable({ ...q, consumedAt: now }, { now }), (e) => e.code === "FX_QUOTE_CONSUMED");
  assert.throws(() => fx.assertQuoteUsable(q, { now, baseCurrency: "GBP", quoteCurrency: "NGN" }), (e) => e.code === "FX_QUOTE_MISMATCH");
  assert.throws(() => fx.assertQuoteUsable(null), (e) => e.code === "FX_QUOTE_NOT_FOUND");
});

test("fx: guards on buffer, ttl, stale or invalid rates, same currency", () => {
  const now = new Date();
  assert.throws(() => fx.buildQuote({ ...base, asOf: now, bufferBps: -1 }), (e) => e.code === "FX_BUFFER_INVALID");
  assert.throws(() => fx.buildQuote({ ...base, asOf: now, bufferBps: 5000 }), (e) => e.code === "FX_BUFFER_INVALID");
  assert.throws(() => fx.buildQuote({ ...base, asOf: now, ttlMs: 3_600_000 }), (e) => e.code === "FX_TTL_INVALID");
  assert.throws(() => fx.buildQuote({ ...base, asOf: new Date(now.getTime() - 10 * 60_000), now }), (e) => e.code === "FX_RATE_STALE");
  assert.throws(() => fx.buildQuote({ ...base, midRate: "0", asOf: now }), (e) => e.code === "FX_RATE_INVALID");
  assert.throws(() => fx.buildQuote({ ...base, midRate: "1e3", asOf: now }), (e) => e.code === "FX_RATE_INVALID");
  assert.throws(() => fx.buildQuote({ ...base, quoteCurrency: "USD", asOf: now }), (e) => e.code === "FX_SAME_CURRENCY");
});

test("static FX provider is development-only and parses its config strictly", async () => {
  assert.throws(() => new StaticFxProvider({ env: "production", rates: "USD:NGN=1500" }), /disabled in production/);
  const p = new StaticFxProvider({ env: "test", rates: "USD:NGN=1500.25; GBP:NGN=1900" });
  assert.equal((await p.getRate("USD", "NGN")).rate, "1500.25");
  assert.equal((await p.getRate("GBP", "NGN")).source, "static-dev");
  await assert.rejects(() => p.getRate("EUR", "NGN"), /No static FX rate/);
  assert.throws(() => new StaticFxProvider({ env: "test", rates: "USD-NGN=1" }), /Bad FX_STATIC_RATES/);
});

test("fxService: create persists a quote; consume is single-use and re-checks expiry", async () => {
  const store = new Map();
  let id = 0;
  const FxQuotes = {
    async create(agencyId, q) { const row = { id: `q${++id}`, agency_id: agencyId, base_currency: q.baseCurrency, quote_currency: q.quoteCurrency, expires_at: q.expiresAt, consumed_at: null }; store.set(row.id, row); return row; },
    async get(qid) { return store.get(qid) || null; },
    async consume(qid, agencyId, by) { const r = store.get(qid); if (!r || r.consumed_at) return null; r.consumed_at = new Date(); r.consumed_by = by; return r; },
  };
  const provider = new StaticFxProvider({ env: "test", rates: "USD:NGN=1500" });
  const q = await createQuote({ provider, FxQuotes, agencyId: "a1", baseCurrency: "USD", quoteCurrency: "NGN", bufferBps: 50 });
  assert.equal(q.base_currency, "USD");
  const used = await consumeQuote({ FxQuotes, agencyId: "a1", quoteId: q.id, consumedBy: "order:1", baseCurrency: "USD", quoteCurrency: "NGN" });
  assert.equal(used.consumed_by, "order:1");
  await assert.rejects(() => consumeQuote({ FxQuotes, agencyId: "a1", quoteId: q.id, consumedBy: "order:2" }), (e) => e.code === "FX_QUOTE_CONSUMED");
  await assert.rejects(() => consumeQuote({ FxQuotes, agencyId: "a1", quoteId: "nope", consumedBy: "x" }), (e) => e.code === "FX_QUOTE_NOT_FOUND");
  const q2 = await createQuote({ provider, FxQuotes, agencyId: "a1", baseCurrency: "USD", quoteCurrency: "NGN", ttlMs: 1000 });
  await assert.rejects(() => consumeQuote({ FxQuotes, agencyId: "a1", quoteId: q2.id, consumedBy: "x", now: new Date(Date.now() + 5000) }), (e) => e.code === "FX_QUOTE_EXPIRED");
});
