// Rules for agent-assisted bookings. Pure functions: no database, no Express.
const { checkApproval } = require("./approval");

const AUTOMATED_APPROVAL_MINUTES = 30;
// A person has to act, so the approval must outlive the queue wait. Override with AGENT_APPROVAL_TTL_HOURS.
function approvalTtlMinutes(mode, env = process.env) {
  if (mode !== "agent_assisted") return AUTOMATED_APPROVAL_MINUTES;
  const h = Number(env.AGENT_APPROVAL_TTL_HOURS);
  return Number.isFinite(h) && h > 0 && h <= 24 * 14 ? Math.round(h * 60) : 48 * 60;
}

// Which fulfilment mode applies when an item is approved?
//  - nothing asked for: automated, unless the agency books for its clients (self-booking off) -> agent_assisted;
//  - agent_assisted can always be asked for;
//  - a traveller cannot choose automated when their agency has self-booking off.
function resolveMode({ requested, principal, agencySelfBooking = true }) {
  const mustUseAgent = !!principal && principal.role === "traveller" && agencySelfBooking === false;
  if (requested !== undefined && requested !== null && !["automated", "agent_assisted"].includes(requested)) return { error: "INVALID_MODE" };
  if (mustUseAgent) return requested === "automated" ? { error: "SELF_BOOKING_DISABLED" } : { mode: "agent_assisted", forced: true };
  return { mode: requested || "automated", forced: false };
}

const isStaffPrincipal = (p) => !!p && (p.role === "admin" || p.role === "agent");

function canClaim(principal, request) {
  if (!isStaffPrincipal(principal) || !request) return { ok: false, reason: "FORBIDDEN" };
  if (principal.agencyId !== request.agency_id) return { ok: false, reason: "NOT_FOUND" };
  if (request.status !== "open") return { ok: false, reason: "NOT_OPEN" };
  return { ok: true };
}

// Working a claimed request: the agent who claimed it, an admin, or an API key (back office).
function canWork(principal, request) {
  if (!isStaffPrincipal(principal) || !request) return { ok: false, reason: "FORBIDDEN" };
  if (principal.agencyId !== request.agency_id) return { ok: false, reason: "NOT_FOUND" };
  if (request.status !== "claimed") return { ok: false, reason: "NOT_CLAIMED" };
  const mine = principal.type !== "session" || request.claimed_by_user_id === principal.userId || principal.role === "admin";
  return mine ? { ok: true } : { ok: false, reason: "CLAIMED_BY_SOMEONE_ELSE" };
}

// Completing at or below the approved price is fine; above it needs a fresh approval from the traveller.
function checkCompletion(approval, { finalPrice, currency }, now = new Date()) {
  const live = { offerId: approval && approval.offerId, price: finalPrice, currency, valid: true };
  return checkApproval(approval, live, now);
}

function validateCompletion(b = {}) {
  const ref = typeof b.confirmationRef === "string" ? b.confirmationRef.trim() : "";
  if (!ref || ref.length > 80 || /[\r\n]/.test(ref)) return { error: "A confirmation reference is required (max 80 characters)." };
  const price = Number(b.finalPrice);
  if (!(price > 0) || price > 10_000_000) return { error: "Enter the final price paid." };
  if (!/^[A-Z]{3}$/.test(String(b.currency || ""))) return { error: "Currency must be a 3-letter code, e.g. USD." };
  const note = b.note === undefined ? "" : String(b.note).trim();
  if (note.length > 1000) return { error: "Note is too long (max 1000 characters)." };
  return { value: { confirmationRef: ref, finalPrice: Math.round(price * 100) / 100, currency: b.currency, note: note || null } };
}

function validateReason(b = {}, field = "reason") {
  const r = typeof b[field] === "string" ? b[field].trim() : "";
  if (r.length < 3 || r.length > 500) return { error: "Give a short reason (3 to 500 characters) so the traveller knows what happened." };
  return { value: r };
}

function validateReprice(b = {}) {
  const price = Number(b.newPrice);
  if (!(price > 0) || price > 10_000_000) return { error: "Enter the new price." };
  const note = typeof b.note === "string" ? b.note.trim() : "";
  if (note.length < 3 || note.length > 500) return { error: "Explain why the price changed (3 to 500 characters)." };
  return { value: { newPrice: Math.round(price * 100) / 100, note } };
}

const validateTravellerNote = (n) => (n === undefined || n === null ? { value: null } : typeof n === "string" && n.length <= 500 ? { value: n.trim() || null } : { error: "Note is too long (max 500 characters)." });

module.exports = { approvalTtlMinutes, resolveMode, canClaim, canWork, checkCompletion, validateCompletion, validateReason, validateReprice, validateTravellerNote, AUTOMATED_APPROVAL_MINUTES };
