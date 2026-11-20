// Executes settlement actions against a payment provider with a durable, idempotent record.
//
// For every action:  (1) write "<type>_requested" to the append-only ledger (unique key)  ->  (2) call the provider with
// the SAME idempotency key  ->  (3) atomically write the completion entry AND update the payment counters.
// A crash between 1 and 3 is recovered by re-running: the provider call is idempotent by key and the completion
// entry is unique, so money cannot be captured, released or refunded twice.
//
// Outcomes of a failed provider call:
//   * error.definitive === true  -> recorded as <type>_failed and ESCALATED (booking state is never touched);
//   * anything else (timeout, DNS, 5xx) -> "in_doubt": nothing is concluded; the sweep retries with the same key.

async function executeAction(action, { payment, provider, Ledger, Payments, now = () => new Date() }) {
  const base = { agencyId: payment.agency_id, orderId: payment.order_id, paymentId: payment.id, amountMinor: action.amountMinor, currency: action.currency };

  const done = await Ledger.findByKey(`${action.key}:done`);
  if (done) return { action: action.type, result: "already_done" };

  // Guards evaluated against the LEDGER (the source of truth), not the possibly stale payment row.
  const bal = await Ledger.balances(payment.id);
  if (action.type === "capture" && bal.captured + action.amountMinor > bal.authorized) return { action: action.type, result: "escalate", code: "CAPTURE_EXCEEDS_AUTHORIZATION" };
  if (action.type === "refund" && action.amountMinor > bal.captured - bal.refunded) return { action: action.type, result: "escalate", code: "REFUND_EXCEEDS_BALANCE" };

  await Ledger.append({ ...base, kind: `${action.type}_requested`, idempotencyKey: `${action.key}:req`, providerRef: payment.provider_ref });

  let providerResult;
  try {
    const args = { providerRef: payment.provider_ref, amountMinor: action.amountMinor, currency: action.currency, idempotencyKey: action.key, releaseRemainder: Boolean(action.releaseRemainder) };
    providerResult = await provider[action.type](args);
  } catch (err) {
    if (err && err.definitive === true) {
      await Ledger.append({ ...base, kind: `${action.type}_failed`, idempotencyKey: `${action.key}:fail:${now().getTime()}`, detail: { error: String(err.message).slice(0, 300) } });
      if (action.type === "capture") await Payments.markCaptureFailed(payment.id);
      return { action: action.type, result: "failed", code: `${action.type.toUpperCase()}_FAILED`, error: err.message };
    }
    return { action: action.type, result: "in_doubt", error: err && err.message };
  }

  await Payments.applySettlementCompletion(payment.id, { kind: action.type, entry: { ...base, kind: action.type, idempotencyKey: `${action.key}:done`, providerRef: (providerResult && providerResult.providerRef) || payment.provider_ref } });
  return { action: action.type, result: "done" };
}

/** Runs every action of a decision in order; stops at the first non-success so partial progress is never hidden. */
async function runSettlement(decision, deps) {
  const results = [];
  for (const action of decision.actions) {
    const r = await executeAction(action, deps);
    results.push(r);
    if (!["done", "already_done"].includes(r.result)) break;
  }
  return results;
}

module.exports = { executeAction, runSettlement };
