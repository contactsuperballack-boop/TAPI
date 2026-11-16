// What the language model may see about a traveller. Allowlist, not
// redaction: a field that isn't listed here can never reach the model, even
// if someone adds it to the profile later. Passport, date of birth, phone and
// email are resolved server-side from `travelers` at booking time by id.

const MODEL_VISIBLE_FIELDS = ["id", "firstName", "homeAirport", "nationality", "preferences", "loyaltyPrograms"];
const MODEL_VISIBLE_PREFS = ["cabinClass", "seatPreference", "dietary", "hotelTier", "maxLayovers"];

function toModelView(traveller) {
  const view = {};
  for (const k of MODEL_VISIBLE_FIELDS) if (traveller && traveller[k] !== undefined) view[k] = traveller[k];
  if (view.preferences && typeof view.preferences === "object") {
    const prefs = {};
    for (const k of MODEL_VISIBLE_PREFS) if (view.preferences[k] !== undefined) prefs[k] = view.preferences[k];
    view.preferences = prefs;
  }
  if (Array.isArray(view.loyaltyPrograms)) {
    // program names only, never account numbers
    view.loyaltyPrograms = view.loyaltyPrograms.map((p) => (typeof p === "string" ? p : p && p.program)).filter(Boolean);
  }
  return view;
}

// Test/guard helper: throws if any secret value appears anywhere in a payload.
function assertNoSecrets(payload, secrets) {
  const haystack = JSON.stringify(payload);
  for (const s of secrets.filter(Boolean)) {
    if (haystack.includes(String(s))) throw new Error("PII leak: a protected value appears in the payload");
  }
}

// For API responses to the UI: never return a full passport number.
function maskPassport(n) {
  if (!n) return null;
  const c = String(n).trim();
  return c.length <= 4 ? "••••" : `${"•".repeat(Math.max(4, c.length - 3))}${c.slice(-3)}`;
}

module.exports = { toModelView, assertNoSecrets, maskPassport, MODEL_VISIBLE_FIELDS };
