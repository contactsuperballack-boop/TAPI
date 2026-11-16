// Approval gate (pure logic). An approval authorises ONE booking of ONE offer
// at ONE price, once. checkApproval() decides whether a booking may proceed
// right now; the atomic "consume" step lives in the repository so two
// concurrent bookings cannot both pass.

const DEFAULT_TTL_MINUTES = 30;

function buildApproval({ agencyId, tripId, tripItemId, offerId, price, currency, toleranceBps = 0, ttlMinutes = DEFAULT_TTL_MINUTES, now = new Date() }) {
  if (!offerId) throw new Error("offerId is required");
  if (!(Number(price) > 0)) throw new Error("price must be a positive number");
  if (!currency) throw new Error("currency is required");
  if (toleranceBps < 0 || toleranceBps > 1000) throw new Error("toleranceBps must be between 0 and 1000");
  return {
    agencyId, tripId, tripItemId, offerId,
    approvedPrice: Number(price), currency,
    tolerancePct: toleranceBps / 100,
    status: "active",
    expiresAt: new Date(now.getTime() + ttlMinutes * 60_000),
  };
}

// live = the freshly revalidated offer from TAPI: { offerId, price, currency, valid }
// Returns { ok: true } or { ok: false, reason, ... }. Order matters: cheapest, most
// certain checks first; price drift last.
function checkApproval(approval, live, now = new Date()) {
  if (!approval) return { ok: false, reason: "NO_APPROVAL" };
  if (approval.status !== "active") return { ok: false, reason: `APPROVAL_${String(approval.status).toUpperCase()}` };
  if (new Date(approval.expiresAt) <= now) return { ok: false, reason: "APPROVAL_EXPIRED" };
  if (!live || live.valid === false) return { ok: false, reason: "OFFER_NO_LONGER_VALID" };
  if (live.offerId !== approval.offerId) return { ok: false, reason: "OFFER_MISMATCH" };
  if (live.currency !== approval.currency) return { ok: false, reason: "CURRENCY_CHANGED" };
  const livePrice = Number(live.price);
  if (!Number.isFinite(livePrice)) return { ok: false, reason: "PRICE_UNAVAILABLE" };
  const ceiling = approval.approvedPrice * (1 + Number(approval.tolerancePct || 0) / 100);
  if (livePrice > ceiling + 1e-9) {
    return { ok: false, reason: "PRICE_INCREASED", approvedPrice: approval.approvedPrice, livePrice };
  }
  return { ok: true, livePrice };
}

// DB row (snake_case) -> the camelCase shape checkApproval() works on.
function fromRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    offerId: r.offer_id ?? r.offerId,
    approvedPrice: Number(r.approved_price ?? r.approvedPrice),
    currency: r.currency,
    tolerancePct: Number(r.tolerance_pct ?? r.tolerancePct ?? 0),
    status: r.status,
    expiresAt: r.expires_at ?? r.expiresAt,
    consumedBookingId: r.consumed_booking_id ?? r.consumedBookingId ?? null,
  };
}

module.exports = { DEFAULT_TTL_MINUTES, buildApproval, checkApproval, fromRow };
