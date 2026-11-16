// User-facing money path for TAPI Agent trips. These routes, not model tools, are the only way to create an
// approval or start a booking. Mounted behind authenticate + tenant limiter + audit like every /v1 route.
//
// Who may do what (domain/access.js): a traveller sees and acts on only their own trips; agents and admins act
// for any client in their agency (and attest the client's consent when approving); API keys act as admin.
// Internal calls back into TAPI's own API use a server-only service credential, never the caller's token, so
// a traveller's session can never reach the raw booking endpoints.
const express = require("express");
const { Errors, ApiError } = require("../domain/errors");
const { Trips } = require("../repositories/trips");
const { TripApprovals } = require("../repositories/tripApprovals");
const { buildApproval } = require("../domain/approval");
const { mapBookingStatusToItemStatus, deriveTripState, assertValidTripTransition, pathForward } = require("../domain/tripStateMachine");
const { canAccessTrip, checkApprover, isTraveller } = require("../domain/access");
const { missingForBooking } = require("../domain/profile");
const { Offers } = require("../repositories");
const { labelPrice } = require("../domain/priceProvenance");
const { runAgentTurn } = require("../agent/agentLoop");
const { TOOL_SPECS, createToolHandlers } = require("../agent/tools");
const { getModel } = require("../agent/modelFactory");
const F = require("../domain/fulfilment");
const { Fulfilment } = require("../repositories/fulfilment");
const { executeApprovedBooking } = require("../agent/bookingExecutor");
const { createTapiClient } = require("../agent/tapiClient");
const { getServiceToken } = require("../services/internalAuth");
const { syncTripStatus } = require("../services/tripSync");
const { requireIdempotencyKey } = require("../middleware/idempotency");

const router = express.Router();
const bad = (detail) => new ApiError("VALIDATION_ERROR", 400, "Invalid request", detail);

// Move the trip forward through planning -> approval -> booking as the user acts; never backwards, never out of a terminal state.
async function advanceTrip(trip, target) {
  for (const next of pathForward(trip.status, target)) { await Trips.setStatus(trip.id, trip.agency_id, next); trip.status = next; }
}

// 404 (not 403) for trips the caller may not see, so ids cannot be probed.
async function loadTrip(req) {
  const trip = await Trips.get(req.params.tripId, req.tenant.agencyId);
  if (!trip || !canAccessTrip(req.principal, trip)) throw Errors.NotFound("Trip");
  return trip;
}

function internalTapi(req) {
  return createTapiClient({
    baseUrl: process.env.TAPI_INTERNAL_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`,
    apiKey: getServiceToken(),
    headers: { "X-Agency-Id": req.tenant.agencyId, "X-Actor": (req.principal && req.principal.actor) || "agent" },
  });
}

const APPROVER_ERRORS = {
  EMAIL_NOT_VERIFIED: () => new ApiError("EMAIL_NOT_VERIFIED", 403, "Verify your email", "Confirm your email address before approving or booking. Use the link we sent you, or ask for a new one."),
  SELF_BOOKING_DISABLED: () => new ApiError("SELF_BOOKING_DISABLED", 403, "Your agent books for you", "This agency completes bookings for its clients. Your agent will take it from here."),
  CONSENT_REQUIRED: () => bad("Confirm that your client has agreed to this price and booking (clientConsent: true)."),
  NOT_FOUND: () => Errors.NotFound("Trip"),
};
function requireApprover(req, trip, extra) {
  const v = checkApprover(req.principal, trip, { agencySelfBooking: req.principal.travellerSelfBooking !== false, ...extra });
  if (!v.ok) throw (APPROVER_ERRORS[v.reason] || (() => Errors.Forbidden("Not allowed")))();
  return v;
}

router.post("/", async (req, res, next) => {
  try {
    const agencyId = req.tenant.agencyId;
    const { title, origin, destination, startDate, endDate, budget, currency, travelerId, brief } = req.body || {};
    if (!title || typeof title !== "string") throw bad("title is required");
    let owner = travelerId || null;
    if (isTraveller(req.principal)) owner = req.principal.travelerId; // a traveller's trips are always their own
    else if (owner && !(await Trips.travelerBelongsToAgency(owner, agencyId))) throw Errors.NotFound("Traveller");
    const trip = await Trips.create({ agencyId, travelerId: owner, createdByUserId: req.principal.userId, title, origin, destination, startDate, endDate, budget, currency, brief });
    res.status(201).json(trip);
  } catch (err) { next(err); }
});

router.get("/", async (req, res, next) => {
  try {
    const travelerId = isTraveller(req.principal) ? req.principal.travelerId : undefined;
    if (isTraveller(req.principal) && !travelerId) return res.json({ trips: [] });
    res.json({ trips: await Trips.list(req.tenant.agencyId, { travelerId }) });
  } catch (err) { next(err); }
});

router.get("/:tripId", async (req, res, next) => {
  try {
    const trip = await loadTrip(req);
    res.json({ ...trip, items: await Trips.listItems(trip.id, req.tenant.agencyId) });
  } catch (err) { next(err); }
});

router.patch("/:tripId", async (req, res, next) => {
  try {
    const agencyId = req.tenant.agencyId;
    const trip = await loadTrip(req);
    const { title, travelerId } = req.body || {};
    // Only staff may reassign a trip to another traveller.
    let newTraveler = null;
    if (travelerId && !isTraveller(req.principal)) {
      if (!(await Trips.travelerBelongsToAgency(travelerId, agencyId))) throw Errors.NotFound("Traveller");
      newTraveler = travelerId;
    }
    const updated = await Trips.update(trip.id, agencyId, { title, travelerId: newTraveler });
    await Trips.event(agencyId, trip.id, "trip_updated", { title: !!title, travelerId: !!newTraveler, by: req.principal.actor });
    res.json(updated);
  } catch (err) { next(err); }
});

router.get("/:tripId/events", async (req, res, next) => {
  try {
    const trip = await loadTrip(req);
    res.json({ events: await Trips.events(trip.id, req.tenant.agencyId) });
  } catch (err) { next(err); }
});

// Add an offer the user picked from a search. Price and currency come from the offer row TAPI stored for THIS
// agency, never from the request body.
router.post("/:tripId/items", async (req, res, next) => {
  try {
    const agencyId = req.tenant.agencyId;
    const { kind, offerId } = req.body || {};
    if (!["flight", "hotel"].includes(kind)) throw bad("kind must be flight or hotel");
    if (!offerId) throw bad("offerId is required");
    const trip = await loadTrip(req);
    const offer = await Offers.get(offerId, agencyId);
    if (!offer || offer.type !== kind) throw Errors.NotFound("Offer");
    if (offer.expires_at && new Date(offer.expires_at) <= new Date()) throw Errors.OfferExpired(offerId);
    const retrievedAt = new Date();
    const item = await Trips.addProposedItem({ agencyId, tripId: trip.id, kind, offerId: offer.id,
      quotedPrice: Number(offer.price), currency: offer.currency, priceLabel: labelPrice({ source: "tapi", retrievedAt, now: retrievedAt }),
      details: offer.payload });
    await Trips.event(agencyId, trip.id, "item_proposed", { itemId: item.id, kind, source: "user", by: req.principal.actor });
    await advanceTrip(trip, "researching");
    res.status(201).json(item);
  } catch (err) { next(err); }
});

// Approve ONE item at the price the user was shown. acknowledgedPrice/currency must equal the item's quoted
// price, so a UI cannot approve a different number than the one on screen. Agents approving for a client must
// attest the client's consent; the approver and that attestation are stored with the approval.
router.post("/:tripId/items/:itemId/approve", async (req, res, next) => {
  try {
    const agencyId = req.tenant.agencyId;
    const { confirm, acknowledgedPrice, currency, toleranceBps, clientConsent, fulfilment, travellerNote } = req.body || {};
    if (confirm !== true) throw bad("confirm must be true");
    const trip = await loadTrip(req);
    const resolved = F.resolveMode({ requested: fulfilment, principal: req.principal, agencySelfBooking: req.principal.travellerSelfBooking !== false });
    if (resolved.error === "INVALID_MODE") throw bad("fulfilment must be automated or agent_assisted");
    if (resolved.error) throw APPROVER_ERRORS[resolved.error]();
    const mode = resolved.mode;
    const note = F.validateTravellerNote(travellerNote); if (note.error) throw bad(note.error);
    // Self-booking being off only blocks the AUTOMATED route; asking an agent to book is always allowed.
    const who = requireApprover(req, trip, { clientConsent: clientConsent === true, agencySelfBooking: true });
    const item = await Trips.getItem(req.params.itemId, trip.id, agencyId);
    if (!item) throw Errors.NotFound("Trip item");
    // "approved" is allowed so an item whose approval EXPIRED can be re-approved; an item with a live approval hits the unique index (409).
    if (!["proposed", "selected", "approved"].includes(item.status)) throw bad(`item is '${item.status}' and cannot be approved`);
    if (Number(acknowledgedPrice) !== Number(item.quoted_price) || currency !== item.currency) {
      throw new ApiError("PRICE_MISMATCH", 409, "Price mismatch", "acknowledgedPrice/currency do not match the quoted price. Re-fetch the trip and show the current price.");
    }
    const a = buildApproval({ agencyId, tripId: item.trip_id, tripItemId: item.id, offerId: item.offer_id, price: item.quoted_price, currency: item.currency, toleranceBps: toleranceBps || 0, ttlMinutes: F.approvalTtlMinutes(mode) });
    a.approvedByUserId = req.principal.userId || null; a.approvedByRole = who.role; a.consentAttested = who.consentAttested;
    await TripApprovals.expireStale(item.id, agencyId);
    const row = await TripApprovals.create(a);
    let requestId = null;
    if (mode === "agent_assisted") {
      requestId = (await Fulfilment.createWithItem({ agencyId, tripId: trip.id, itemId: item.id, approvalId: row.id, requestedByUserId: req.principal.userId, requestedByRole: who.role,
        travellerNote: note.value, approvedPrice: item.quoted_price, currency: item.currency })).id;
      await advanceTrip(trip, "booking");
    } else {
      await Trips.setItemMode(item.id, agencyId, "automated");
      await Trips.setItemStatus(item.id, agencyId, "approved");
      await advanceTrip(trip, "awaiting_approval");
    }
    await Trips.event(agencyId, trip.id, mode === "agent_assisted" ? "agent_requested" : "item_approved", { itemId: item.id, approvalId: row.id, requestId, price: item.quoted_price, currency: item.currency, by: req.principal.actor, role: who.role, consentAttested: who.consentAttested, forced: resolved.forced });
    res.status(201).json({ approvalId: row.id, expiresAt: row.expires_at, fulfilment: mode, requestId });
  } catch (err) {
    if (err && err.code === "23505") return next(new ApiError("ALREADY_APPROVED", 409, "Already approved", "This item already has an active approval."));
    next(err);
  }
});

router.post("/:tripId/items/:itemId/book", requireIdempotencyKey, async (req, res, next) => {
  try {
    const agencyId = req.tenant.agencyId;
    const approvalId = req.body && req.body.approvalId;
    if (!approvalId) throw bad("approvalId is required");
    const trip = await loadTrip(req);
    requireApprover(req, trip, { clientConsent: true }); // consent was attested when the approval was created
    const item = await Trips.getItem(req.params.itemId, trip.id, agencyId);
    if (!item) throw Errors.NotFound("Trip item");
    if (item.fulfilment_mode === "agent_assisted" && ["agent_requested", "agent_working"].includes(item.status)) {
      throw new ApiError("HANDLED_BY_AGENT", 409, "An agent is handling this", "This booking was sent to an agent, so it cannot be booked automatically.");
    }
    const approval = await TripApprovals.get(approvalId, agencyId);
    if (!approval || approval.trip_item_id !== item.id) throw Errors.NotFound("Approval");
    const party = await Trips.bookingParties(trip);
    if (!trip.traveler_id || !party) throw bad("Choose a traveller for this trip before booking.");
    // Check completeness BEFORE the executor, which consumes the (single-use) approval.
    const missing = missingForBooking(item.kind, party);
    if (missing.length) return res.status(400).json({ code: "PROFILE_INCOMPLETE", title: "Traveller details needed", detail: `Add ${missing.join(", ")} to the traveller's profile before booking.`, missing });

    const bookingBody = item.kind === "flight"
      ? { passengers: [{ firstName: party.first_name, lastName: party.last_name, dateOfBirth: party.date_of_birth, passportNumber: party.passport_number, nationality: party.nationality }], contact: { email: party.email, phone: party.phone || undefined } }
      : { guests: [{ firstName: party.first_name, lastName: party.last_name }], contact: { email: party.email, phone: party.phone || undefined } };

    const result = await executeApprovedBooking({ agencyId, approvalId, kind: item.kind, bookingBody }, { approvals: TripApprovals, tapi: internalTapi(req) });
    if (!result.ok) {
      await Trips.event(agencyId, trip.id, "booking_blocked", { itemId: item.id, reason: result.reason, by: req.principal.actor });
      if (trip.status === "awaiting_approval") { await Trips.setStatus(trip.id, agencyId, "itinerary_ready"); trip.status = "itinerary_ready"; }
      // Give the user a way forward instead of a dead end:
      if (result.reason === "PRICE_INCREASED" && result.livePrice) {
        await Trips.reopenItem(item.id, agencyId, { status: "selected", quotedPrice: result.livePrice, priceLabel: "confirmed" });
      } else if (["PRICE_CHANGED", "OFFER_EXPIRED", "SOLD_OUT", "OFFER_NO_LONGER_VALID"].includes(result.reason)) {
        await Trips.reopenItem(item.id, agencyId, { status: result.reason === "PRICE_CHANGED" ? "selected" : "failed", priceLabel: "unverified" });
      } else if (result.reason === "APPROVAL_EXPIRED") {
        await Trips.reopenItem(item.id, agencyId, { status: "selected" });
      }
      return res.status(409).json({ code: result.reason, title: "Booking not started", detail: "No booking was made and nothing was charged.", ...(result.livePrice ? { livePrice: result.livePrice, approvedPrice: result.approvedPrice } : {}) });
    }
    const bookingId = result.booking.bookingId || result.booking.id;
    await Trips.setItemStatus(item.id, agencyId, mapBookingStatusToItemStatus(result.booking.status), bookingId);
    if (result.livePrice != null) await Trips.confirmPrice(item.id, agencyId, result.livePrice);
    await advanceTrip(trip, "booking");
    await Trips.event(agencyId, trip.id, "booking_started", { itemId: item.id, bookingId, status: result.booking.status, by: req.principal.actor });
    res.status(202).json({ bookingId, status: result.booking.status });
  } catch (err) { next(err); }
});

// Withdraw a request that no agent has started on yet. The item returns to "selected".
router.post("/:tripId/items/:itemId/cancel-request", async (req, res, next) => {
  try {
    const agencyId = req.tenant.agencyId;
    const trip = await loadTrip(req);
    const item = await Trips.getItem(req.params.itemId, trip.id, agencyId);
    if (!item) throw Errors.NotFound("Trip item");
    const out = await Fulfilment.cancelOpen(item.id, agencyId);
    if (!out) throw new ApiError("ALREADY_STARTED", 409, "Already started", "An agent has already started on this. Ask them to stop, or wait for their update.");
    await Trips.event(agencyId, trip.id, "agent_request_withdrawn", { itemId: item.id, by: req.principal.actor });
    await syncTripStatus(agencyId, trip.id);
    res.json({ itemId: item.id, status: "selected" });
  } catch (err) { next(err); }
});

// Pull the booking's current status from TAPI into the trip item, then re-derive the trip state.
router.post("/:tripId/items/:itemId/refresh", async (req, res, next) => {
  try {
    const agencyId = req.tenant.agencyId;
    const trip = await loadTrip(req);
    const item = await Trips.getItem(req.params.itemId, trip.id, agencyId);
    if (!item) throw Errors.NotFound("Trip item");
    if (!item.booking_id) throw bad("item has no booking yet");
    const booking = await internalTapi(req).getBooking(item.kind, item.booking_id);
    const status = mapBookingStatusToItemStatus(booking.status);
    await Trips.setItemStatus(item.id, agencyId, status);
    const items = await Trips.listItems(trip.id, agencyId);
    const next_ = deriveTripState(items);
    if (next_ && next_ !== trip.status) { try { assertValidTripTransition(trip.status, next_); await Trips.setStatus(trip.id, agencyId, next_); } catch (_) { /* illegal jump: leave as is */ } }
    res.json({ itemId: item.id, bookingStatus: booking.status, itemStatus: status });
  } catch (err) { next(err); }
});

router.get("/:tripId/messages", async (req, res, next) => {
  try {
    const trip = await loadTrip(req);
    res.json({ messages: await Trips.messages(trip.id, req.tenant.agencyId), agentAvailable: !!getModel() });
  } catch (err) { next(err); }
});

router.post("/:tripId/messages", async (req, res, next) => {
  try {
    const agencyId = req.tenant.agencyId;
    const text = req.body && typeof req.body.message === "string" ? req.body.message.trim() : "";
    if (!text || text.length > 4000) throw bad("message is required (max 4000 characters)");
    const trip = await loadTrip(req);
    const model = getModel();
    if (!model) throw new ApiError("AGENT_MODEL_NOT_CONFIGURED", 503, "Assistant unavailable", "No AI model is configured for this deployment. You can still search and add offers manually.");
    const party = await Trips.bookingParties(trip);
    const traveller = party ? { id: trip.traveler_id, firstName: party.first_name, nationality: party.nationality, preferences: (trip.brief || {}).preferences } : {};
    const handlers = createToolHandlers({ agencyId, tripId: trip.id, traveller }, { tapi: internalTapi(req), trips: Trips });
    const past = (await Trips.messages(trip.id, agencyId)).filter((m) => m.role !== "tool").slice(-20).map((m) => ({ role: m.role, content: m.content }));
    await Trips.addMessage({ agencyId, tripId: trip.id, role: "user", content: text });
    const out = await runAgentTurn({ model, toolSpecs: TOOL_SPECS, handlers, history: past, userMessage: text });
    await Trips.addMessage({ agencyId, tripId: trip.id, role: "assistant", content: out.text, toolTrace: out.traces });
    res.json({ reply: out.text, degraded: !!out.degraded, tools: out.traces.map((t) => ({ tool: t.tool, status: t.status })) });
  } catch (err) { next(err); }
});

module.exports = router;
