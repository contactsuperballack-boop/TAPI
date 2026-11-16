// The agent queue (staff only): claim a request, then complete it, send it back with a new price, or decline it.
// Money safety is the same as the automated path: an agent can complete only at or below the price the traveller
// approved, using that traveller's single-use approval. Nothing here collects payment (step 3).
const express = require("express");
const { Errors, ApiError } = require("../domain/errors");
const { Fulfilment } = require("../repositories/fulfilment");
const { Trips } = require("../repositories/trips");
const { TripApprovals } = require("../repositories/tripApprovals");
const { fromRow } = require("../domain/approval");
const F = require("../domain/fulfilment");
const { syncTripStatus } = require("../services/tripSync");
const { createNotifier } = require("../services/notify");
const { getMailer } = require("../services/mailer");

const router = express.Router();
const bad = (d) => new ApiError("VALIDATION_ERROR", 400, "Invalid request", d);
const notifier = () => createNotifier({ getMailer: () => getMailer(), baseUrl: process.env.PUBLIC_APP_URL || `http://localhost:${process.env.PORT || 3000}` });
const actor = (req) => req.principal.actor || "api_key";
const UUID = /^[0-9a-f-]{36}$/i;

const view = (r) => ({
  id: r.id, status: r.status, tripId: r.trip_id, tripTitle: r.trip_title, itemId: r.trip_item_id, itemKind: r.item_kind, item: r.item_details || {},
  travellerName: [r.traveller_first_name, r.traveller_last_name].filter(Boolean).join(" ") || null, travellerEmail: r.traveller_email || null,
  travellerNote: r.traveller_note, approvedPrice: Number(r.approved_price), currency: r.currency, approvalExpiresAt: r.approval_expires_at, approvalStatus: r.approval_status,
  claimedBy: r.claimed_by_name || null, claimedByUserId: r.claimed_by_user_id || null, confirmationRef: r.confirmation_ref, finalPrice: r.final_price != null ? Number(r.final_price) : null,
  agentNote: r.agent_note, declineReason: r.decline_reason, createdAt: r.created_at, updatedAt: r.updated_at, completedAt: r.completed_at,
});

async function load(req) {
  if (!UUID.test(req.params.id)) throw Errors.NotFound("Request");
  const r = await Fulfilment.get(req.params.id, req.tenant.agencyId);
  if (!r) throw Errors.NotFound("Request");
  return r;
}
function mustWork(req, r) {
  const v = F.canWork(req.principal, r);
  if (v.ok) return;
  throw ({ NOT_FOUND: () => Errors.NotFound("Request"),
    NOT_CLAIMED: () => new ApiError("NOT_CLAIMED", 409, "Not claimed", "Claim this request first."),
    CLAIMED_BY_SOMEONE_ELSE: () => new ApiError("CLAIMED_BY_SOMEONE_ELSE", 403, "Claimed by someone else", "Another agent is working on this request."),
  }[v.reason] || (() => Errors.Forbidden("Not allowed")))();
}
const userId = (req) => req.principal.userId || null;
const party = async (r) => (r.traveller_email ? { to: r.traveller_email, tripTitle: r.trip_title, tripId: r.trip_id, itemKind: r.item_kind } : null);

router.get("/", async (req, res, next) => {
  try {
    const scope = ["open", "mine", "done"].includes(req.query.scope) ? req.query.scope : "open";
    const rows = await Fulfilment.list(req.tenant.agencyId, { scope, userId: userId(req) });
    res.json({ scope, requests: rows.map(view) });
  } catch (err) { next(err); }
});

router.get("/:id", async (req, res, next) => { try { res.json(view(await load(req))); } catch (err) { next(err); } });

router.post("/:id/claim", async (req, res, next) => {
  try {
    const r = await load(req);
    const v = F.canClaim(req.principal, r);
    if (!v.ok) throw v.reason === "NOT_OPEN" ? new ApiError("ALREADY_CLAIMED", 409, "Already taken", "Someone else already took this request.") : Errors.Forbidden("Not allowed");
    if (!(await Fulfilment.claim(r.id, r.agency_id, userId(req)))) throw new ApiError("ALREADY_CLAIMED", 409, "Already taken", "Someone else just took this request.");
    await Trips.event(r.agency_id, r.trip_id, "agent_claimed", { requestId: r.id, by: actor(req) });
    res.json(view(await Fulfilment.get(r.id, r.agency_id)));
  } catch (err) { next(err); }
});

router.post("/:id/release", async (req, res, next) => {
  try {
    const r = await load(req); mustWork(req, r);
    await Fulfilment.release(r.id, r.agency_id);
    await Trips.event(r.agency_id, r.trip_id, "agent_released", { requestId: r.id, by: actor(req) });
    res.json(view(await Fulfilment.get(r.id, r.agency_id)));
  } catch (err) { next(err); }
});

// The only way full passport details leave the system: the agent who is doing the booking, every time logged.
router.post("/:id/reveal", async (req, res, next) => {
  try {
    const r = await load(req); mustWork(req, r);
    const d = await Fulfilment.travellerDetails(r.traveler_id, r.agency_id);
    if (!d) throw Errors.NotFound("Traveller");
    await Trips.event(r.agency_id, r.trip_id, "pii_revealed", { requestId: r.id, by: actor(req) });
    res.set("Cache-Control", "no-store");
    res.json({ firstName: d.first_name, lastName: d.last_name, dateOfBirth: d.date_of_birth, passportNumber: d.passport_number, nationality: d.nationality, email: d.email, phone: d.phone });
  } catch (err) { next(err); }
});

router.post("/:id/complete", async (req, res, next) => {
  try {
    const r = await load(req); mustWork(req, r);
    const { value, error } = F.validateCompletion(req.body);
    if (error) throw bad(error);
    const check = F.checkCompletion(fromRow(await TripApprovals.get(r.approval_id, r.agency_id)), { finalPrice: value.finalPrice, currency: value.currency });
    if (!check.ok) {
      const msg = { PRICE_INCREASED: `The final price is higher than the traveller approved (${r.currency} ${Number(r.approved_price).toFixed(2)}). Use "Price changed" so they can approve the new price.`,
        CURRENCY_CHANGED: "The currency differs from what the traveller approved. Use \"Price changed\" to ask them to approve it.",
        APPROVAL_EXPIRED: "The traveller's approval has expired. Use \"Price changed\" (same price is fine) to ask them to approve again." }[check.reason] || "This approval can no longer be used.";
      return res.status(409).json({ code: check.reason === "PRICE_INCREASED" ? "PRICE_EXCEEDS_APPROVAL" : check.reason, title: "Cannot complete", detail: `${msg} Nothing was recorded as booked.` });
    }
    const out = await Fulfilment.complete(r, value);
    if (!out.ok) return res.status(409).json({ code: out.reason, title: "Cannot complete", detail: "The approval is no longer available or the request is no longer yours. Nothing was recorded as booked." });
    await Trips.event(r.agency_id, r.trip_id, "agent_completed", { requestId: r.id, by: actor(req), finalPrice: value.finalPrice, currency: value.currency });
    await syncTripStatus(r.agency_id, r.trip_id);
    const p = await party(r); if (p) notifier().bookingConfirmed({ ...p, ref: value.confirmationRef, finalPrice: value.finalPrice, currency: value.currency });
    res.json(view(await Fulfilment.get(r.id, r.agency_id)));
  } catch (err) { next(err); }
});

router.post("/:id/decline", async (req, res, next) => {
  try {
    const r = await load(req); mustWork(req, r);
    const { value, error } = F.validateReason(req.body);
    if (error) throw bad(error);
    const out = await Fulfilment.decline(r, value);
    if (!out.ok) throw new ApiError(out.reason, 409, "Cannot decline", "This request is no longer yours to decline.");
    await Trips.event(r.agency_id, r.trip_id, "agent_declined", { requestId: r.id, by: actor(req), reason: value });
    await syncTripStatus(r.agency_id, r.trip_id);
    const p = await party(r); if (p) notifier().bookingDeclined({ ...p, reason: value });
    res.json(view(await Fulfilment.get(r.id, r.agency_id)));
  } catch (err) { next(err); }
});

router.post("/:id/reprice", async (req, res, next) => {
  try {
    const r = await load(req); mustWork(req, r);
    const { value, error } = F.validateReprice(req.body);
    if (error) throw bad(error);
    const out = await Fulfilment.reprice(r, value);
    if (!out.ok) throw new ApiError(out.reason, 409, "Cannot reprice", "This request is no longer yours to change.");
    await Trips.event(r.agency_id, r.trip_id, "agent_repriced", { requestId: r.id, by: actor(req), newPrice: value.newPrice });
    await syncTripStatus(r.agency_id, r.trip_id);
    const p = await party(r); if (p) notifier().repriced({ ...p, newPrice: value.newPrice, currency: r.currency, note: value.note });
    res.json(view(await Fulfilment.get(r.id, r.agency_id)));
  } catch (err) { next(err); }
});

module.exports = router;
