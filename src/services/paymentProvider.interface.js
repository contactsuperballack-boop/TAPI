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
// What a provider can do. Settlement logic reads these instead of assuming: a provider that only charges immediately
// (authorizeCapture=false) is settled by refund; one that holds funds is settled by capture/void.
const DEFAULT_PAYMENT_CAPABILITIES = Object.freeze({
  authorizeCapture: false, // can place a hold at checkout and capture later
  partialCapture: false,   // can capture less than the authorised amount (releasing the rest)
  partialRefund: false,
  void: false,             // can release an authorisation without charging
});

class PaymentProvider {
  get capabilities() { return DEFAULT_PAYMENT_CAPABILITIES; }

  /**
   * Starts a payment. Returns enough for the client to complete it
   * (a checkout URL, a client secret, etc. — provider-specific).
   * @returns {Promise<{providerRef:string, checkoutUrl:string, status:string}>}
   */
  async createCheckout({ orderId, amount, currency, idempotencyKey, captureMode = "automatic" }) { throw new Error("not implemented"); }

  /** Verifies an inbound webhook actually came from the provider. NEVER trust an unverified webhook. */
  verifyWebhookSignature(rawBody, headers) { throw new Error("not implemented"); }

  /** Parses a verified webhook body into a normalized event. */
  parseWebhookEvent(rawBody) { throw new Error("not implemented"); }

  async refund({ providerRef, amount, amountMinor, idempotencyKey }) { throw new Error("not implemented"); }

  /**
   * Capture (part of) an authorisation. MUST be idempotent by idempotencyKey. Errors that prove nothing happened carry
   * `error.definitive = true`; timeouts and transport errors must NOT (the outcome is unknown).
   */
  async capture({ providerRef, amountMinor, currency, idempotencyKey, releaseRemainder }) { throw new Error("not implemented"); }

  /** Release an authorisation without charging. Idempotent by key; same `definitive` convention. */
  async void({ providerRef, idempotencyKey }) { throw new Error("not implemented"); }
}

module.exports = { PaymentProvider, DEFAULT_PAYMENT_CAPABILITIES };
