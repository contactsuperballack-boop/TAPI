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

  get capabilities() { return { authorizeCapture: true, partialCapture: true, partialRefund: true, void: true }; }

  // Test/failure-injection hook: provider.injectFault("capture", { definitive: false, times: 1 }) makes the next
  // `times` calls to that method throw. definitive=false models a timeout (outcome unknown).
  injectFault(method, { definitive = false, times = 1, message = "injected fault" } = {}) {
    this._faults = this._faults || {};
    this._faults[method] = { definitive, times, message };
  }
  _maybeFault(method) {
    const f = this._faults && this._faults[method];
    if (f && f.times > 0) { f.times--; const e = new Error(f.message); e.definitive = f.definitive; throw e; }
  }
  _once(method, key, fn) {
    this._memo = this._memo || new Map();
    const k = `${method}:${key}`;
    if (!this._memo.has(k)) this._memo.set(k, fn());
    return this._memo.get(k); // idempotent by key, like a real provider
  }

  async capture({ providerRef, amountMinor, idempotencyKey }) {
    this._maybeFault("capture");
    return this._once("capture", idempotencyKey, () => ({ status: "captured", providerRef, capturedMinor: amountMinor }));
  }

  async void({ providerRef, idempotencyKey }) {
    this._maybeFault("void");
    return this._once("void", idempotencyKey, () => ({ status: "voided", providerRef }));
  }

  async createCheckout({ orderId, amount, currency, idempotencyKey, captureMode = "automatic" }) {
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
      status: data.status, // 'authorized' | 'captured' | 'failed'
      amount: data.amount,
      currency: data.currency,
      // Real providers give a stable event id per event, unchanged across
      // retried deliveries of the SAME event — that's what dedup needs.
      // Optional here since the mock provider's test fixtures predate this
      // field; a real adapter should always populate it.
      eventId: data.event_id || null,
      authorizationExpiresAt: data.authorization_expires_at ? new Date(data.authorization_expires_at) : null,
    };
  }

  async refund({ providerRef, amount, amountMinor, idempotencyKey }) {
    this._maybeFault("refund");
    return this._once("refund", idempotencyKey || `${providerRef}:${amount}`, () => ({ status: "refunded", providerRef, refundedAmount: amount, refundedMinor: amountMinor }));
  }
}

module.exports = { MockPaymentProvider };
