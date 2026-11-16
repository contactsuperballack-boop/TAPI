// Redacts traveler/guest PII before it's written to supplier_bookings audit
// records. Fixes a confirmed gap: raw_request previously stored names,
// dates of birth, passport numbers, nationality, and contact details in
// plaintext with no redaction, encryption, retention policy, or
// access-control layer.
//
// This solves the "written in plaintext by default" part of the problem.
// It does NOT solve encryption-at-rest, retention/deletion policy, or
// database-level access control — those are infrastructure/ops decisions
// (who can query this table, how long rows live, whether the column itself
// needs pgcrypto) that belong in Sprint 5/production hardening, not
// something a redaction function can fix on its own. Stated here rather
// than implied solved.
//
// The full (unredacted) data still goes to the supplier — this only affects
// what TAPI itself persists for audit/debugging purposes.
const REDACT = "[REDACTED]";

function redactString(value) {
  if (typeof value !== "string" || value.length === 0) return value;
  if (value.length <= 4) return REDACT;
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

function redactTraveler(traveler) {
  if (!traveler || typeof traveler !== "object") return traveler;
  return {
    ...traveler,
    firstName: traveler.firstName ? redactString(traveler.firstName) : undefined,
    lastName: traveler.lastName ? redactString(traveler.lastName) : undefined,
    dateOfBirth: traveler.dateOfBirth ? REDACT : undefined,
    passportNumber: traveler.passportNumber ? REDACT : undefined,
    nationality: traveler.nationality, // low sensitivity, kept for supplier-coverage debugging
  };
}

function redactContact(contact) {
  if (!contact || typeof contact !== "object") return contact;
  return {
    ...contact,
    email: contact.email ? redactString(contact.email) : undefined,
    phone: contact.phone ? REDACT : undefined,
  };
}

/**
 * Redacts a booking request body (the shape passed to
 * Bookings.recordSupplierAudit) before it's persisted. Handles both the
 * flights shape ({ passengers, contact }) and the hotels shape
 * ({ guests, contact }).
 */
function redactBookingAuditPayload(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const redacted = { ...payload };
  if (Array.isArray(redacted.passengers)) redacted.passengers = redacted.passengers.map(redactTraveler);
  if (Array.isArray(redacted.guests)) redacted.guests = redacted.guests.map(redactTraveler);
  if (redacted.contact) redacted.contact = redactContact(redacted.contact);
  return redacted;
}

// Sprint 1 hardening: redactBookingAuditPayload (above) redacts raw_request,
// because TAPI constructs that payload itself and knows its exact shape
// ({ passengers/guests, contact }). raw_response was NOT redacted — it's
// whatever the supplier sends back, and per README/GO_LIVE_CHECKLIST several
// LetsFG response shapes (hotel search/book especially) are explicitly
// UNVERIFIED. A supplier can echo the same traveler PII back in its
// response (confirmation payloads routinely include passenger/guest names,
// contact details, and — for the hotel flow, which requires "a card on
// file" per README — potentially card metadata). A shape-specific redactor
// like redactBookingAuditPayload can't be written for a shape nobody has
// confirmed yet, so this instead redacts by KEY NAME, recursively, matching
// common PII/payment field names regardless of where they appear in the
// tree. This is deliberately broader/blunter than the request-side
// redaction — it will redact some non-sensitive fields with adjacent names
// (e.g. an unrelated "companyName") as a false positive, which is the
// correct trade-off for data nobody has verified the shape of yet. Revisit
// once real LetsFG response shapes are confirmed (see GO_LIVE_CHECKLIST.md)
// and a precise, shape-specific redactor can replace this.
const PII_KEY_PATTERN =
  /(first.?name|last.?name|full.?name|given.?name|family.?name|guest.?name|passenger.?name|traveler.?name|date.?of.?birth|\bdob\b|passport|national.?id|\bssn\b|social.?security|e.?mail|phone|address|card.?number|card.?holder|\bcvv\b|\bcvc\b|account.?number|\biban\b|\bswift\b)/i;

function redactSupplierResponsePayload(value, keyHint = null, depth = 0) {
  if (depth > 10) return value; // guard against pathological/circular nesting in an unverified shape
  if (Array.isArray(value)) return value.map((item) => redactSupplierResponsePayload(item, keyHint, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) out[key] = redactSupplierResponsePayload(val, key, depth + 1);
    return out;
  }
  // Leaf value — redact if the key that held it looks like PII/payment data.
  if (keyHint && PII_KEY_PATTERN.test(keyHint) && value !== null && value !== undefined) {
    return typeof value === "string" ? redactString(value) : REDACT;
  }
  return value;
}

module.exports = { redactBookingAuditPayload, redactSupplierResponsePayload, redactTraveler, redactContact };
