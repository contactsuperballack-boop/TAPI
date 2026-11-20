// A source of market FX rates. No production provider has been chosen (open decision). The interface returns the
// rate AND when it was observed, so the quote engine can refuse stale data.
class FxProvider {
  /** @returns {Promise<{rate:string, asOf:Date, source:string}>} units of `quote` per 1 unit of `base` */
  async getRate(base, quote) { throw new Error("not implemented"); }
}

/**
 * Development/sandbox provider with rates from env: FX_STATIC_RATES="USD:NGN=1500.25;GBP:NGN=1900".
 * NEVER a market source: refuses to run when NODE_ENV=production unless explicitly allowed.
 */
class StaticFxProvider extends FxProvider {
  constructor({ rates = process.env.FX_STATIC_RATES || "", env = process.env.NODE_ENV, allowProduction = false, now = () => new Date() } = {}) {
    super();
    if (env === "production" && !allowProduction) throw new Error("StaticFxProvider is for development/sandbox only and is disabled in production.");
    this.now = now;
    this.rates = new Map();
    for (const part of String(rates).split(";").map((x) => x.trim()).filter(Boolean)) {
      const m = part.match(/^([A-Z]{3}):([A-Z]{3})=(\d+(\.\d+)?)$/);
      if (!m) throw new Error(`Bad FX_STATIC_RATES entry '${part}'`);
      this.rates.set(`${m[1]}:${m[2]}`, m[3]);
    }
  }
  async getRate(base, quote) {
    const rate = this.rates.get(`${base}:${quote}`);
    if (!rate) throw new Error(`No static FX rate configured for ${base}->${quote}`);
    return { rate, asOf: this.now(), source: "static-dev" };
  }
}

module.exports = { FxProvider, StaticFxProvider };
