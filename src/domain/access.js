// Who may do what. Pure functions so the rules can be unit tested without a database.
//
// Principals (set by middleware/auth.js):
//   { type:'api_key',  role:'admin',  agencyId }                       agency API key (developer / back-office)
//   { type:'session',  role:'admin'|'agent'|'traveller', agencyId, userId, travelerId?, emailVerified }
//   { type:'service',  role:'admin', agencyId }                        TAPI calling itself (internal HTTP)

const STAFF_ROLES = ["admin", "agent"];
const isStaff = (p) => !!p && STAFF_ROLES.includes(p.role);
const isTraveller = (p) => !!p && p.role === "traveller";

// Deny-by-default for travellers: they may reach only these endpoints. Everything else under /v1
// (orders, raw bookings, operators, staff, other travellers) is staff/API-key only.
const TRAVELLER_ALLOW = [
  { methods: ["GET", "POST", "PATCH"], re: /^\/v1\/trips(\/|$)/ },
  { methods: ["GET", "POST"], re: /^\/v1\/(flights|hotels)\/search(\/|$)/ },
  { methods: ["GET"], re: /^\/v1\/travelers\/?$/ },
  { methods: ["GET", "PATCH"], re: /^\/v1\/travelers\/me\/?$/ },
  { methods: ["GET", "POST"], re: /^\/v1\/account\/(me|logout|resend-verification)\/?$/ },
];
function travellerMayCall(method, path) {
  const p = String(path).split("?")[0];
  // Our ids are plain UUIDs, so any dot-segment, empty segment or percent-encoding is never legitimate:
  // refuse it rather than rely on how the router would interpret it.
  if (/(^|\/)\.{1,2}(\/|$)|\/\/|%/.test(p)) return false;
  return TRAVELLER_ALLOW.some((r) => r.methods.includes(method) && r.re.test(p));
}

// A traveller sees only trips for their own traveler record; staff/API keys see the whole agency.
// Callers must already have filtered by agency_id in SQL; this is the second, per-person check.
function canAccessTrip(principal, trip) {
  if (!principal || !trip) return false;
  if (trip.agency_id && principal.agencyId && trip.agency_id !== principal.agencyId) return false;
  if (isTraveller(principal)) return !!principal.travelerId && trip.traveler_id === principal.travelerId;
  return true;
}

// May this principal approve spending on this trip right now?
//   - session users need a verified email (fraud control);
//   - a traveller can approve only their own trip, and only if the agency allows self-booking;
//   - staff approving for someone else must attest the client's consent.
function checkApprover(principal, trip, { clientConsent = false, agencySelfBooking = true } = {}) {
  if (!canAccessTrip(principal, trip)) return { ok: false, reason: "NOT_FOUND" };
  if (principal.type === "session" && !principal.emailVerified) return { ok: false, reason: "EMAIL_NOT_VERIFIED" };
  if (isTraveller(principal)) {
    if (!agencySelfBooking) return { ok: false, reason: "SELF_BOOKING_DISABLED" };
    return { ok: true, role: "traveller", consentAttested: false };
  }
  if (principal.type === "session" && !clientConsent) return { ok: false, reason: "CONSENT_REQUIRED" };
  return { ok: true, role: principal.role, consentAttested: principal.type === "session" ? true : !!clientConsent };
}

module.exports = { STAFF_ROLES, isStaff, isTraveller, travellerMayCall, canAccessTrip, checkApprover };
