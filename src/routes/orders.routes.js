const express = require("express");
const { Orders, Payments, Offers, Bookings, hashRequestBody } = require("../repositories");
const db = require("../db");
const { requireIdempotencyKey } = require("../middleware/idempotency");
const { Errors } = require("../domain/errors");
const { computeOrderPricing } = require("../domain/pricing");
const { getPaymentProvider } = require("../services/paymentProviderRegistry");
const { createOrderSchema, validateBody } = require("../validation/schemas");

const router = express.Router();

// POST /v1/orders — create an order around one or more existing bookings (T-070, T-071)
router.post("/", requireIdempotencyKey, validateBody(createOrderSchema), async (req, res, next) => {
  try {
    const { bookingIds, customerId } = req.body;

    // Idempotency is checked FIRST, before any booking validation. This is
    // the fix for a confirmed bug: checking "is this booking already
    // attached to an order" before checking "did this idempotency key
    // already create that exact order" meant a legitimate retry — which
    // sees its own already-attached booking — was rejected with a 400
    // instead of returning the original order. A retry must be
    // indistinguishable from success, not something that requires the
    // booking to still be unclaimed.
    const existingOrder = await Orders.findByIdempotencyKey(req.tenant.agencyId, req.idempotencyKey);
    if (existingOrder) {
      return res.status(200).json(toOrderResponse(existingOrder));
    }

    // Every booking must belong to this agency, exist, and actually be
    // confirmed — you can't invoice something that might still fail or
    // require further customer action. This mirrors the same "don't trust
    // a supplier's success signal" discipline as the booking-state mapper.
    const bookings = [];
    for (const id of bookingIds) {
      const booking = await Bookings.get(id, req.tenant.agencyId);
      if (!booking) throw Errors.NotFound(`Booking ${id}`);
      if (booking.status !== "confirmed") {
        throw Errors.ValidationFailed(`Booking ${id} is '${booking.status}', not 'confirmed' — cannot be added to an order yet.`);
      }
      if (booking.order_id) {
        throw Errors.ValidationFailed(`Booking ${id} already belongs to order ${booking.order_id}.`);
      }
      bookings.push(booking);
    }

    const offers = [];
    for (const b of bookings) {
      const offer = await Offers.get(b.offer_id, req.tenant.agencyId);
      if (!offer) throw Errors.Internal(`Offer for booking ${b.id} missing — data integrity issue.`);
      offers.push(offer);
    }

    const pricing = computeOrderPricing(offers); // throws on mixed currency

    const { order, isNew } = await Orders.createOrGetExisting({
      agencyId: req.tenant.agencyId,
      customerId,
      bookingIds,
      idempotencyKey: req.idempotencyKey,
      pricing,
    });

    res.status(isNew ? 201 : 200).json(toOrderResponse(order));
  } catch (err) {
    next(err);
  }
});

// GET /v1/orders/:orderId
router.get("/:orderId", async (req, res, next) => {
  try {
    const order = await Orders.get(req.params.orderId, req.tenant.agencyId);
    if (!order) throw Errors.NotFound("Order");
    const bookings = await Orders.listBookings(order.id, req.tenant.agencyId);
    res.json({ ...toOrderResponse(order), bookingIds: bookings.map((b) => b.id) });
  } catch (err) {
    next(err);
  }
});

// POST /v1/orders/:orderId/pay — initiate payment (T-072, idempotent, retryable on prior failure)
router.post("/:orderId/pay", requireIdempotencyKey, async (req, res, next) => {
  try {
    const order = await Orders.get(req.params.orderId, req.tenant.agencyId);
    if (!order) throw Errors.NotFound("Order");
    if (order.status !== "open") {
      throw Errors.ValidationFailed(`Order ${order.id} is '${order.status}', not 'open' — cannot initiate payment.`);
    }

    const provider = getPaymentProvider();
    const { payment, isNew } = await Payments.createOrGetExisting({
      agencyId: req.tenant.agencyId,
      orderId: order.id,
      provider: "mock", // single active provider in MVP — see paymentProviderRegistry.js
      amount: order.total_price,
      currency: order.currency,
      idempotencyKey: req.idempotencyKey,
    });

    if (!isNew && payment.provider_ref) {
      // A completed attempt already exists for this key — never call the
      // provider twice, same principle as booking creation.
      return res.status(200).json(toPaymentResponse(payment));
    }

    // Either a brand-new payment, OR a retry where the previous attempt
    // created a payment row but never got a provider_ref back (the
    // provider.createCheckout() call itself failed or the process died
    // before it completed). Fix for a confirmed bug: this used to return
    // the stale checkout-less payment forever, permanently stranding the
    // client with no way to actually pay. Now it retries the provider call
    // against the SAME payment record and idempotency key.
    const checkout = await provider.createCheckout({
      orderId: order.id,
      amount: order.total_price,
      currency: order.currency,
      idempotencyKey: req.idempotencyKey,
    });
    const updated = await Payments.setProviderRef(payment.id, checkout.providerRef, checkout.checkoutUrl);

    res.status(201).json(toPaymentResponse(updated));
  } catch (err) {
    next(err);
  }
});

// POST /v1/orders/:orderId/refund — T-076. Requires a captured payment.
router.post("/:orderId/refund", requireIdempotencyKey, async (req, res, next) => {
  try {
    const order = await Orders.get(req.params.orderId, req.tenant.agencyId);
    if (!order) throw Errors.NotFound("Order");

    const payment = await Payments.getByOrderId(order.id, req.tenant.agencyId);

    // Fix for a confirmed bug: idempotency was checked against order.status,
    // but a successful refund CHANGES order.status to 'cancelled' — so a
    // retry (network blip before the client saw the first response, etc.)
    // would hit "order is not 'paid'" and return an error instead of the
    // original success. Checking payment.status first makes a retry after
    // a successful refund a no-op that returns the same result, not a
    // different failure mode than the first call.
    if (payment && payment.status === "refunded") {
      return res.json({ orderId: order.id, status: "cancelled", refund: { status: "refunded", alreadyProcessed: true } });
    }

    if (order.status !== "paid") {
      throw Errors.ValidationFailed(`Order ${order.id} is '${order.status}', not 'paid' — nothing to refund.`);
    }
    if (!payment || payment.status !== "captured") {
      throw Errors.ValidationFailed(`Order ${order.id} has no captured payment to refund.`);
    }

    const bookings = await Orders.listBookings(order.id, req.tenant.agencyId);

    // Transition to refund_pending BEFORE calling the provider — this is
    // "we've initiated a refund attempt," recorded even if the provider
    // call itself fails, so the booking never silently stays 'confirmed'
    // while money is mid-refund.
    //
    // Tracks which booking IDs were actually transitioned in a local array
    // rather than re-checking `booking.status` later — that in-memory
    // value is a snapshot from the initial fetch above and never updates
    // after the DB transition, so checking it again in the catch block or
    // after the transaction would always see the stale pre-transition value.
    const refundPendingBookingIds = [];
    for (const booking of bookings) {
      if (booking.status === "confirmed") {
        await Bookings.transition(booking.id, "refund_pending", { actor: req.tenant.apiClientId, reason: "order refund initiated" });
        refundPendingBookingIds.push(booking.id);
      }
    }

    const provider = getPaymentProvider();
    // idempotencyKey passed through for when a real provider (Paystack/
    // Stripe/etc.) replaces the mock — MockPaymentProvider ignores it, so
    // provider-side refund idempotency is still NOT actually verified here;
    // that requires a real provider's idempotency semantics, which don't
    // exist yet. Stated, not silently assumed solved.
    let result;
    try {
      result = await provider.refund({ providerRef: payment.provider_ref, amount: payment.amount, idempotencyKey: req.idempotencyKey });
    } catch (err) {
      // Fix for a real gap: previously a provider.refund() failure just
      // propagated as a 500 with the booking(s) stuck wherever they were.
      // Now the booking is explicitly marked refund_failed — visible,
      // queryable, and distinct from 'confirmed' (money was never
      // successfully returned) or 'refunded' (it was).
      for (const bookingId of refundPendingBookingIds) {
        await Bookings.transition(bookingId, "refund_failed", { actor: "system", reason: `provider refund failed: ${err.message}` });
      }
      throw err;
    }

    // Local state updates wrapped in a transaction — fixes the other half
    // of the confirmed gap: these were two independent writes that could
    // partially land if the process died between them.
    const { order: updatedOrder } = await db.withTransaction(async (tx) => {
      await tx.query(`UPDATE payments SET status='refunded' WHERE id=$1`, [payment.id]);
      const { rows } = await tx.query(`UPDATE orders SET status='cancelled' WHERE id=$1 RETURNING *`, [order.id]);
      return { order: rows[0] };
    });

    for (const bookingId of refundPendingBookingIds) {
      await Bookings.transition(bookingId, "refunded", { actor: "system", reason: "provider confirmed refund" });
    }

    res.json({ orderId: updatedOrder.id, status: updatedOrder.status, refund: result });
  } catch (err) {
    next(err);
  }
});

function toOrderResponse(order) {
  return {
    orderId: order.id,
    status: order.status, // open | paid | cancelled
    currency: order.currency,
    supplierCost: order.supplier_cost,
    markupAmount: order.markup_amount,
    serviceFee: order.service_fee,
    taxAmount: order.tax_amount,
    totalPrice: order.total_price,
    createdAt: order.created_at,
  };
}

function toPaymentResponse(payment) {
  return {
    paymentId: payment.id,
    orderId: payment.order_id,
    status: payment.status, // pending | authorized | captured | failed | refunded | disputed
    amount: payment.amount,
    currency: payment.currency,
    checkoutUrl: payment.checkout_url || null, // persisted (migration 007) — survives past the initial response
    createdAt: payment.created_at,
  };
}

module.exports = router;
