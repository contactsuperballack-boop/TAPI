// Creates and consumes FX quotes. Dependencies injected (provider, repository) so it is unit-testable.
const { buildQuote, assertQuoteUsable, FxError } = require("../domain/fx");

async function createQuote({ provider, FxQuotes, agencyId, baseCurrency, quoteCurrency, bufferBps = Number(process.env.FX_BUFFER_BPS || 100), ttlMs, now = new Date() }) {
  const { rate, asOf, source } = await provider.getRate(baseCurrency, quoteCurrency);
  const quote = buildQuote({ baseCurrency, quoteCurrency, midRate: rate, bufferBps, ttlMs, asOf, source, now });
  return FxQuotes.create(agencyId, quote);
}

/**
 * Atomically uses a quote ONCE. The repository's conditional UPDATE is the arbiter; on a miss we diagnose why so the
 * caller can return a precise error (expired / already used / not found) instead of a generic failure.
 */
async function consumeQuote({ FxQuotes, agencyId, quoteId, consumedBy, baseCurrency, quoteCurrency, now = new Date() }) {
  const existing = await FxQuotes.get(quoteId, agencyId);
  assertQuoteUsable(existing, { now, baseCurrency, quoteCurrency }); // throws a precise FxError
  const consumed = await FxQuotes.consume(quoteId, agencyId, consumedBy);
  if (!consumed) throw new FxError("FX_QUOTE_CONSUMED", "this quote was used by a concurrent request");
  return consumed;
}

module.exports = { createQuote, consumeQuote };
