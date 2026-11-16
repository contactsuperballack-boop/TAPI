// Payment webhook receiver. NOT behind agency API-key auth — the provider
// calls this, not an agency — but every request is signature-verified, and
// an invalid signature is rejected outright (Master Spec §17 acceptance
// criteria: "Payment webhook is rejected when signature is invalid").
//
// This is the ONLY code path that can move a payment to 'captured' or
// 'failed'. A client polling/callback can never do this (Master Spec §13:
// "Never mark an order paid solely from a client callback").
const express = require("express");
const { Payments } = require("../repositories");
const { getPaymentProvider } = require("../services/paymentProviderRegistry");

const router = express.Router();

// Mounted with express.raw() in app.js (BEFORE the global express.json()
// parser) specifically so req.body here is the raw Buffer — signature
// verification must run against the exact bytes the provider signed, not a
// re-serialized JSON object, which is not guaranteed to be byte-identical.
router.post("/webhook", async (req, res, next) => {
  try {
    const provider = getPaymentProvider();
    const rawBody = req.body; // Buffer, thanks to express.raw()

    if (!provider.verifyWebhookSignature(rawBody, req.headers)) {
      return res.status(401).json({ code: "INVALID_WEBHOOK_SIGNATURE", detail: "Webhook signature verification failed." });
    }

    const event = provider.parseWebhookEvent(rawBody);
    const payment = await Payments.findByProviderRef("mock", event.providerRef);
    if (!payment) {
      // Unknown reference — don't 500, but don't pretend success either.
      return res.status(404).json({ code: "UNKNOWN_PAYMENT_REFERENCE" });
    }

    // Idempotent against duplicate webhook deliveries (providers routinely
    // retry): if this payment already reached a terminal state, don't
    // reprocess it.
    if (payment.status === "captured" || payment.status === "failed") {
      return res.status(200).json({ received: true, alreadyProcessed: true });
    }

    // Fix for a confirmed gap: the webhook's amount/currency were parsed but
    // never actually checked against what TAPI itself recorded for this
    // payment. A validly-signed webhook with the wrong amount (a provider
    // bug, a stale/replayed event, a different currency) could previously
    // still capture the payment and mark the order paid. Signature proves
    // the event came from the provider; it does NOT prove the event matches
    // what we expect for this specific payment — that's a separate check.
    if (event.status === "captured") {
      const amountMatches = Number(event.amount) === Number(payment.amount);
      const currencyMatches = event.currency === payment.currency;
      if (!amountMatches || !currencyMatches) {
        return res.status(409).json({
          code: "WEBHOOK_AMOUNT_MISMATCH",
          detail: `Webhook reported ${event.amount} ${event.currency}, but payment ${payment.id} expects ${payment.amount} ${payment.currency}. Not captured — needs manual review.`,
        });
      }
      try {
        await Payments.markCapturedAndOrderPaid(payment.id, payment.order_id, event.eventId);
      } catch (err) {
        if (err.code === "BOOKING_NOT_CAPTURABLE") {
          // Real guard, not a server error: the underlying booking(s) moved
          // to a non-capturable state (cancelled/refund_*) between order
          // creation and this webhook arriving. Money should NOT move for
          // this — surface it as a distinct, diagnosable response rather
          // than letting it fall through to a bare 500.
          return res.status(409).json({ code: err.code, detail: err.message });
        }
        throw err;
      }
    } else if (event.status === "failed") {
      await Payments.markFailedFromWebhook(payment.id);
    }
    // Any other event status is ignored rather than guessed at — same
    // "unrecognized -> don't assume success" discipline as the booking-state mapper.

    res.status(200).json({ received: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
