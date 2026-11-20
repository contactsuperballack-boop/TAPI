// Standard machine-readable error contract (T-024).
// Every thrown ApiError becomes a stable RFC 7807 Problem Details response —
// never a raw stack trace, never a leaked supplier payload.
class ApiError extends Error {
  constructor(code, status, message, detail) {
    super(message);
    this.code = code;
    this.status = status;
    this.detail = detail || message;
  }
}

const Errors = {
  Unauthorized: (detail) => new ApiError("UNAUTHORIZED", 401, "Unauthorized", detail),
  Forbidden: (detail) => new ApiError("FORBIDDEN", 403, "Forbidden", detail),
  NotFound: (resource) => new ApiError("NOT_FOUND", 404, `${resource} not found`, `${resource} not found`),
  ValidationFailed: (detail) => new ApiError("VALIDATION_FAILED", 400, "Request validation failed", detail),
  OfferExpired: (offerId) =>
    new ApiError("OFFER_EXPIRED", 410, "Offer expired", `Offer ${offerId} is no longer valid. Re-run search.`),
  IdempotencyKeyRequired: () =>
    new ApiError("IDEMPOTENCY_KEY_REQUIRED", 400, "Idempotency-Key header required", "Mutating requests require an Idempotency-Key header."),
  IdempotencyKeyReused: (key) =>
    new ApiError(
      "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY",
      422,
      "Idempotency key reused with a different request body",
      `Idempotency-Key '${key}' was already used for a booking with a different request body. Use a new key for a genuinely different booking, or resend the exact same body to retry.`
    ),
  SupplierUnavailable: (detail) => new ApiError("SUPPLIER_UNAVAILABLE", 502, "Supplier unavailable", detail),
  SupplierNotConfigured: (detail) =>
    new ApiError("SUPPLIER_NOT_CONFIGURED", 503, "Supplier not configured", detail),
  SupplierTimeout: (detail) => new ApiError("SUPPLIER_TIMEOUT", 504, "Supplier timeout", detail),
  PriceChanged: (detail) => new ApiError("PRICE_CHANGED", 409, "Supplier price changed", detail),
  SoldOut: () => new ApiError("SOLD_OUT", 409, "Offer sold out", "This offer is no longer available."),
  BookingInProgressForOffer: (detail) => new ApiError("BOOKING_IN_PROGRESS_FOR_OFFER", 409, "A booking for this offer already exists", detail),
  NotSupported: (detail) => new ApiError("NOT_SUPPORTED", 501, "Not supported by this supplier", detail),
  Internal: (detail) => new ApiError("INTERNAL_ERROR", 500, "Internal error", detail),
};

module.exports = { ApiError, Errors };
