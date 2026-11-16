// Mock payment provider — for development and testing ONLY. Does not move
// real money. Exists so the order/payment state machine, webhook handling,
// and idempotency logic can be built and tested before a real provider
// (Paystack, Flutterwave, Stripe, etc.) is chosen — that choice is still
// open (see paymentProvider.interface.js header).
//
// Webhook signature scheme here is a simple HMAC-SHA256 over the raw body
// using a shared secret — this is NOT any real provider's actual scheme
// (Paystack/Flutterwave/Stripe all differ). Swap this file for a real
// adapter once the Decision Gate resolves; the interface contract stays
// the same so routes/orders.routes.js and routes/payments.routes.js don't change.
const crypto = require("crypto");
const { PaymentProvider } = require("../paymentProvider.interface");

class MockPaymentProvider extends PaymentProvider {
  constructor({ webhookSecret, baseUrl = "https://mock-payments.tapi.internal" } = {}) {
    super();
    this.webhookSecret = webhookSecret || "dev-only-insecure-secret";
    this.baseUrl = baseUrl;
  }

  async createCheckout({ orderId, amount, currency, idempotencyKey }) {
    const providerRef = `mock_pay_${crypto.randomBytes(12).toString("hex")}`;
    return {
      providerRef,
      checkoutUrl: `${this.baseUrl}/checkout/${providerRef}?amount=${amount}&currency=${currency}`,
      status: "pending",
    };
  }

  verifyWebhookSignature(rawBody, headers) {
    const signature = headers["x-mock-signature"];
    if (!signature) return false;
    const expected = crypto.createHmac("sha256", this.webhookSecret).update(rawBody).digest("hex");
    // Constant-time comparison — a naive === comparison here would leak
    // timing information about how much of the signature matched.
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  parseWebhookEvent(rawBody) {
    const data = JSON.parse(rawBody);
    return {
      providerRef: data.provider_ref,
      status: data.status, // 'captured' | 'failed'
      amount: data.amount,
      currency: data.currency,
      // Real providers give a stable event id per event, unchanged across
      // retried deliveries of the SAME event — that's what dedup needs.
      // Optional here since the mock provider's test fixtures predate this
      // field; a real adapter should always populate it.
      eventId: data.event_id || null,
    };
  }

  async refund({ providerRef, amount }) {
    return { status: "refunded", providerRef, refundedAmount: amount };
  }
}

module.exports = { MockPaymentProvider };
