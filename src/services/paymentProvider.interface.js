// Contract every payment provider adapter must implement (T-072).
//
// No real provider has cleared the Product Owner Decision Gate yet
// (TAPI Master Product Document §6: "Customer payment model" is still an
// open business decision — prepaid, agency credit/wallet, or both — and no
// specific provider like Paystack/Flutterwave/Stripe has been chosen). This
// interface exists so that decision doesn't block the order/payment domain
// model and state machine from being built — same reasoning as the supplier
// abstraction: build against the interface, plug in the real adapter once
// the business decision lands.
class PaymentProvider {
  /**
   * Starts a payment. Returns enough for the client to complete it
   * (a checkout URL, a client secret, etc. — provider-specific).
   * @returns {Promise<{providerRef:string, checkoutUrl:string, status:string}>}
   */
  async createCheckout({ orderId, amount, currency, idempotencyKey }) { throw new Error("not implemented"); }

  /** Verifies an inbound webhook actually came from the provider. NEVER trust an unverified webhook. */
  verifyWebhookSignature(rawBody, headers) { throw new Error("not implemented"); }

  /** Parses a verified webhook body into a normalized event. */
  parseWebhookEvent(rawBody) { throw new Error("not implemented"); }

  async refund({ providerRef, amount, idempotencyKey }) { throw new Error("not implemented"); }
}

module.exports = { PaymentProvider };
