// Settlement decisions (pure). Given a payment and the outcomes of the bookings it pays for, decide what money should
// move — and, as importantly, when NOTHING should move.
//
// Invariants this module exists to enforce:
//   * never capture or release money while any booking's outcome is still ambiguous (hold);
//   * capture only for confirmed bookings; void/refund the rest;
//   * refund never exceeds what was captured and not yet refunded;
//   * if the provider cannot do what a partial outcome needs, escalate to a human instead of guessing;
//   * a booking confirmed with a failed capture is never un-confirmed here — it is escalated.
//
// Amounts are integer minor units in the PAYMENT's currency. The caller allocates the payment total across bookings.

const { toMinor, allocate } = require("./money");

const CONFIRMED = new Set(["confirmed"]);
const FAILED = new Set(["failed", "cancelled", "refunded"]);
const AUTH_EXPIRY_WARN_MS = 24 * 3600_000;

/**
 * @param {{id:string, status:string, currency:string, totalMinor:number, authorizedMinor?:number, capturedMinor?:number,
 *          refundedMinor?:number, authorizationExpiresAt?:Date|string|null}} payment
 * @param {Array<{id:string, status:string, amountMinor:number}>} bookings  amounts must sum to payment.totalMinor
 * @param {{partialCapture?:boolean, partialRefund?:boolean, void?:boolean}} caps
 * @returns {{state:'noop'|'hold'|'settle'|'settled'|'escalate', actions:Array, escalate:null|{code:string, detail:string}}}
 */
function decideSettlement(payment, bookings, caps = {}, now = new Date()) {
  const out = (state, actions = [], escalate = null) => ({ state, actions, escalate });
  if (!["authorized", "captured"].includes(payment.status)) return out("noop");
  if (!bookings.length) return out("noop");

  const sum = bookings.reduce((a, b) => a + b.amountMinor, 0);
  if (sum !== payment.totalMinor) return out("escalate", [], { code: "ALLOCATION_MISMATCH", detail: `booking amounts (${sum}) do not equal the payment total (${payment.totalMinor})` });

  const ambiguous = bookings.filter((b) => !CONFIRMED.has(b.status) && !FAILED.has(b.status));
  if (ambiguous.length) {
    const exp = payment.authorizationExpiresAt ? new Date(payment.authorizationExpiresAt) : null;
    if (payment.status === "authorized" && exp && exp.getTime() - now.getTime() < AUTH_EXPIRY_WARN_MS) {
      return out("escalate", [], { code: "AUTHORIZATION_EXPIRING", detail: `authorization lapses ${exp.toISOString()} while ${ambiguous.length} booking(s) are unresolved` });
    }
    return out("hold");
  }

  const confirmedMinor = bookings.filter((b) => CONFIRMED.has(b.status)).reduce((a, b) => a + b.amountMinor, 0);
  const cur = payment.currency;

  if (payment.status === "authorized") {
    const authorized = payment.authorizedMinor ?? payment.totalMinor;
    if (confirmedMinor === 0) {
      if (!caps.void) return out("escalate", [], { code: "VOID_UNSUPPORTED", detail: "provider cannot void an authorization" });
      return out("settle", [{ type: "void", amountMinor: authorized, currency: cur, key: `void:${payment.id}` }]);
    }
    if (confirmedMinor > authorized) return out("escalate", [], { code: "CAPTURE_EXCEEDS_AUTHORIZATION", detail: `confirmed ${confirmedMinor} > authorized ${authorized}` });
    if (confirmedMinor < authorized && !caps.partialCapture) return out("escalate", [], { code: "PARTIAL_CAPTURE_UNSUPPORTED", detail: "mixed outcome needs a partial capture the provider cannot do" });
    return out("settle", [{ type: "capture", amountMinor: confirmedMinor, currency: cur, key: `capture:${payment.id}:${confirmedMinor}`, releaseRemainder: confirmedMinor < authorized }]);
  }

  // captured: money is already ours; return whatever was not fulfilled.
  const captured = payment.capturedMinor ?? payment.totalMinor;
  const refunded = payment.refundedMinor ?? 0;
  const due = captured - confirmedMinor - refunded;
  if (due <= 0) return out("settled");
  if (due > captured - refunded) return out("escalate", [], { code: "REFUND_EXCEEDS_BALANCE", detail: "refund due exceeds the refundable balance" });
  if (due < captured && !caps.partialRefund) return out("escalate", [], { code: "PARTIAL_REFUND_UNSUPPORTED", detail: "provider cannot refund part of a payment" });
  return out("settle", [{ type: "refund", amountMinor: due, currency: cur, key: `refund:${payment.id}:${refunded}:${due}` }]);
}

/** Shape a DB payment row for the pure decision function. */
function toDecisionPayment(row) {
  return {
    id: row.id, status: row.status, currency: row.currency,
    totalMinor: toMinor(row.amount, row.currency),
    authorizedMinor: Number(row.authorized_minor) || undefined,
    capturedMinor: Number(row.captured_minor) || 0,
    refundedMinor: Number(row.refunded_minor) || 0,
    authorizationExpiresAt: row.authorization_expires_at,
  };
}

/**
 * Policy (needs Product Owner confirmation): the payment total — supplier cost, markup AND fees — is allocated across
 * the order's bookings in proportion to each offer's supplier price. A failed booking therefore returns its
 * proportional share of fees too.
 */
function allocateAcrossBookings(paymentTotalMinor, bookings) {
  const currencies = new Set(bookings.map((b) => b.currency));
  if (currencies.size > 1) return { error: { code: "MIXED_CURRENCY_ORDER", detail: `bookings priced in ${[...currencies].join(", ")}` } };
  const weights = bookings.map((b) => toMinor(b.price, b.currency));
  if (weights.every((w) => w === 0)) return { error: { code: "ALLOCATION_IMPOSSIBLE", detail: "all booking prices are zero" } };
  const parts = allocate(paymentTotalMinor, weights);
  return { amounts: bookings.map((b, i) => ({ id: b.id, status: b.status, amountMinor: parts[i] })) };
}


module.exports = { decideSettlement, allocateAcrossBookings, toDecisionPayment, AUTH_EXPIRY_WARN_MS };
