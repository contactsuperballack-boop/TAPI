// Order pricing config. The actual markup/commission model is an open
// Product Owner Decision Gate item (TAPI Master Product Document §6:
// "Agency pricing/markup/commission model"). Reading these from env rather
// than hardcoding a percentage means the business decision, once made,
// is a config change — not a code change or a deploy. Same principle as
// market tiering (§3.2): commercial judgment calls don't belong in code.
//
// Defaults are 0 — i.e. cost-through pricing — so the MVP doesn't silently
// start charging a markup nobody agreed to just because this file exists.
function getPricingConfig() {
  return {
    markupPercent: Number(process.env.ORDER_MARKUP_PERCENT || 0),
    serviceFeeFlat: Number(process.env.ORDER_SERVICE_FEE_FLAT || 0),
    // Tax handling is explicitly out of scope for MVP — no jurisdiction
    // decision has been made. Always 0 until that's a real requirement.
    taxAmount: 0,
  };
}

/**
 * Computes the price breakdown for an order from its constituent bookings'
 * offer prices. All bookings must share a currency — multi-currency orders
 * are out of scope for MVP (would need FX handling, a separate decision).
 */
function computeOrderPricing(offers) {
  const { markupPercent, serviceFeeFlat, taxAmount } = getPricingConfig();

  const currencies = new Set(offers.map((o) => o.currency));
  if (currencies.size > 1) {
    throw new Error(`Order contains bookings in multiple currencies (${[...currencies].join(", ")}) — not supported in MVP.`);
  }
  const currency = offers[0]?.currency;

  const supplierCost = offers.reduce((sum, o) => sum + Number(o.price), 0);
  const markupAmount = Math.round(supplierCost * (markupPercent / 100) * 100) / 100;
  const serviceFee = serviceFeeFlat;
  const totalPrice = Math.round((supplierCost + markupAmount + serviceFee + taxAmount) * 100) / 100;

  return { currency, supplierCost, markupAmount, serviceFee, taxAmount, totalPrice };
}

module.exports = { getPricingConfig, computeOrderPricing };
