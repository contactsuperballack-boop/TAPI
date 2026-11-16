// Idempotency middleware (T-027, T-074). Required on booking/payment/cancellation
// mutations so retries never create duplicate supplier bookings.
// The actual "has this key been used" check happens against the bookings table
// itself (idempotency_key is UNIQUE) — this middleware just enforces the header
// is present and attaches it to the request.
const { Errors } = require("../domain/errors");

function requireIdempotencyKey(req, res, next) {
  const key = req.header("Idempotency-Key");
  if (!key) return next(Errors.IdempotencyKeyRequired());
  req.idempotencyKey = key;
  next();
}

module.exports = { requireIdempotencyKey };
