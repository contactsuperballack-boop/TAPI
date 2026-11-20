// FX quote engine (pure). A quote LOCKS a rate (plus TAPI's protective buffer) for a short window so a traveller is
// shown, approves and pays a price that cannot drift underneath them, and so TAPI's exposure between quote and
// settlement is bounded by the buffer and the TTL. Rounding always favours TAPI's ability to cover the supplier
// (customer amounts round UP). No float arithmetic: BigInt over decimal strings.
const { exponent } = require("./money");

const RATE_SCALE = 10n ** 10n;
const DEFAULT_TTL_MS = 10 * 60_000;
const MAX_TTL_MS = 15 * 60_000;
const MAX_BUFFER_BPS = 1000;          // 10%
const DEFAULT_MAX_RATE_AGE_MS = 5 * 60_000;

class FxError extends Error {
  constructor(code, detail) { super(`${code}: ${detail}`); this.code = code; this.detail = detail; }
}

function parseRate(rate) {
  const s = String(rate).trim();
  if (!/^\d+(\.\d{1,10})?$/.test(s)) throw new FxError("FX_RATE_INVALID", `rate '${rate}' must be a positive decimal with at most 10 places`);
  const [i, f = ""] = s.split(".");
  const scaled = BigInt(i) * RATE_SCALE + BigInt(f.padEnd(10, "0"));
  if (scaled <= 0n) throw new FxError("FX_RATE_INVALID", "rate must be positive");
  return scaled;
}

/**
 * @param {{baseCurrency:string, quoteCurrency:string, midRate:string|number, bufferBps?:number, ttlMs?:number,
 *          asOf:Date, source:string, now?:Date, maxRateAgeMs?:number}} p
 * "base" is what the supplier charges; "quote" is what the customer pays.
 */
function buildQuote(p) {
  const now = p.now || new Date();
  const bufferBps = p.bufferBps ?? 0;
  const ttlMs = p.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isInteger(bufferBps) || bufferBps < 0 || bufferBps > MAX_BUFFER_BPS) throw new FxError("FX_BUFFER_INVALID", `bufferBps must be an integer 0..${MAX_BUFFER_BPS}`);
  if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS) throw new FxError("FX_TTL_INVALID", `ttlMs must be 1..${MAX_TTL_MS}`);
  if (!p.asOf || now.getTime() - p.asOf.getTime() > (p.maxRateAgeMs ?? DEFAULT_MAX_RATE_AGE_MS)) throw new FxError("FX_RATE_STALE", "the market rate is older than the allowed age");
  if (p.baseCurrency === p.quoteCurrency) throw new FxError("FX_SAME_CURRENCY", "no FX quote is needed for a single-currency price");
  parseRate(p.midRate); // validate
  return {
    baseCurrency: p.baseCurrency,
    quoteCurrency: p.quoteCurrency,
    midRate: String(p.midRate),
    bufferBps,
    source: p.source,
    asOf: p.asOf,
    createdAt: now,
    expiresAt: new Date(now.getTime() + ttlMs),
  };
}

/** Supplier amount (base minor units) -> customer amount (quote minor units), rounded UP, buffer included. */
function convertUp(quote, baseMinor) {
  if (!Number.isSafeInteger(baseMinor) || baseMinor < 0) throw new FxError("FX_AMOUNT_INVALID", "amount must be a non-negative integer of minor units");
  const rate = parseRate(quote.midRate);
  const num = BigInt(baseMinor) * rate * 10n ** BigInt(exponent(quote.quoteCurrency)) * BigInt(10000 + quote.bufferBps);
  const den = 10n ** BigInt(exponent(quote.baseCurrency)) * RATE_SCALE * 10000n;
  const out = (num + den - 1n) / den;
  if (out > BigInt(Number.MAX_SAFE_INTEGER)) throw new FxError("FX_AMOUNT_INVALID", "converted amount is too large");
  return Number(out);
}

/** Throws a specific FxError unless the quote may be used right now for this currency pair. */
function assertQuoteUsable(quote, { now = new Date(), baseCurrency, quoteCurrency } = {}) {
  if (!quote) throw new FxError("FX_QUOTE_NOT_FOUND", "no such quote");
  if (quote.consumedAt || quote.consumed_at) throw new FxError("FX_QUOTE_CONSUMED", "this quote has already been used");
  const exp = new Date(quote.expiresAt || quote.expires_at);
  if (exp.getTime() <= now.getTime()) throw new FxError("FX_QUOTE_EXPIRED", "this quote has expired; request a new one and re-approve the new price");
  const b = quote.baseCurrency || quote.base_currency;
  const q = quote.quoteCurrency || quote.quote_currency;
  if ((baseCurrency && b !== baseCurrency) || (quoteCurrency && q !== quoteCurrency)) throw new FxError("FX_QUOTE_MISMATCH", `quote is ${b}->${q}, not ${baseCurrency}->${quoteCurrency}`);
  return true;
}

module.exports = { FxError, buildQuote, convertUp, assertQuoteUsable, parseRate, DEFAULT_TTL_MS, MAX_TTL_MS, MAX_BUFFER_BPS, DEFAULT_MAX_RATE_AGE_MS };
