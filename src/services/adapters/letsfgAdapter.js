// LetsFG flight adapter. The sandbox uses the documented synchronous
// /v1/sandbox/flights/search endpoint; its result is stored in the TAPI
// searches row (encoded supplier ref) so polling remains restart-safe.
// Production keeps the documented async search/results flow.
const { FlightSupplier } = require("../flightSupplier.interface");
const { LetsFGClient } = require("./letsfgClient");
const { Errors } = require("../../domain/errors");

const SANDBOX_RESULT_PREFIX = "letsfg-sandbox-result:";
// The sandbox search result is stored inside the searches row (restart-safe),
// so it must stay small. Offers are trimmed (cheapest-first order preserved)
// until the encoded snapshot fits.
const MAX_SANDBOX_SNAPSHOT_CHARS = 200_000;

class LetsFGAdapter extends FlightSupplier {
  constructor(config) {
    super();
    this.client = new LetsFGClient(config);
  }

  get capabilities() {
    return {
      asyncBooking: true,
      reserveThenTicket: false,
      supportsAnswer: true,
      supportsStop: true,
      supportsCancel: false,
      // Sandbox: LetsFG validates search_id + offer_id when booking. Production: no documented recheck.
      offerValidation: this.client.environment === "sandbox" ? "at-booking" : "none",
      sandbox: this.client.environment === "sandbox",
      // LetsFG receives our idempotency_key on /flights/book, but no documented lookup-by-key was found. Unverified => false.
      lookupByKey: false,
    };
  }

  async resolveLocation(query) {
    if (this.client.authMode !== "developer") {
      throw new Error("LetsFG location resolution requires Developer API authentication.");
    }
    const path = this.client.developerPath(`flights/locations/${encodeURIComponent(query)}`);
    const data = await this.client.request("GET", path);
    return data.locations || data.results || [];
  }

  async search({ origin, destination, departDate, returnDate, adults, children, infants, cabinClass, currency }) {
    if (this.client.environment === "sandbox") {
      const payload = {
        origin,
        destination,
        date_from: departDate,
        ...(returnDate ? { date_to: returnDate } : {}),
        adults,
        ...(children ? { children } : {}),
        ...(infants ? { infants } : {}),
        currency: currency || "USD",
        ...(cabinClass ? { cabin_class: cabinClass } : {}),
      };
      const data = await this.client.request("POST", this.client.developerPath("flights/search"), payload);
      if (!Array.isArray(data.offers)) throw new Error("LetsFG sandbox search response did not contain an offers array.");
      const normalized = data.offers.map((offer) => normalizeOffer(offer, data.search_id));
      return { supplierSearchRef: `${SANDBOX_RESULT_PREFIX}${encodeSandboxSnapshot(normalized)}` };
    }

    const payload = {
      origin,
      destination,
      date_from: departDate,
      ...(returnDate ? { date_to: returnDate } : {}),
      adults,
      ...(children ? { children } : {}),
      ...(infants ? { infants } : {}),
      currency: currency || "USD",
      ...(cabinClass ? { cabin_class: cabinClass } : {}),
    };
    const data = await this.client.request("POST", this.client.developerPath("flights/search/async"), payload);
    return { supplierSearchRef: data.search_id };
  }

  async pollSearch(supplierSearchRef) {
    if (supplierSearchRef.startsWith(SANDBOX_RESULT_PREFIX)) {
      try {
        const encoded = supplierSearchRef.slice(SANDBOX_RESULT_PREFIX.length);
        return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
      } catch (_) {
        throw new Error("Stored LetsFG sandbox search snapshot is invalid.");
      }
    }
    const data = await this.client.request("GET", this.client.developerPath(`flights/results/${encodeURIComponent(supplierSearchRef)}`));
    const status = data.status === "complete" || data.status === "completed" ? "completed"
      : data.status === "error" || data.status === "failed" ? "failed" : "processing";
    return { status, offers: (data.offers || []).map((offer) => normalizeOffer(offer, data.search_id)) };
  }

  async getOffer(supplierOfferRef) {
    throw new Error(`LetsFG does not document a standalone offer lookup for this integration (${supplierOfferRef}); use the stored search offer.`);
  }

  async validateOffer(supplierOfferRef) {
    if (this.client.environment === "sandbox") {
      // The documented sandbox has no separate offer-recheck endpoint.
      // The booking endpoint validates search_id + offer_id at booking time.
      return { valid: true, validationMode: "supplier-validates-at-booking", offer: { supplierOfferRef } };
    }
    throw Errors.NotSupported("LetsFG does not document a separate offer-validation call; production booking must revalidate through the booking workflow before it is enabled.");
  }

  async book(supplierOfferRef, passengers, contact, offerContext = {}) {
    if (!offerContext.supplierSearchId) {
      throw new Error("LetsFG flight booking requires the original supplier search_id.");
    }
    const payload = {
      search_id: offerContext.supplierSearchId,
      offer_id: supplierOfferRef,
      idempotency_key: offerContext.idempotencyKey,
      contact_email: contact.email,
      want_seat: Boolean(offerContext.wantSeat),
      passengers: (passengers || []).map(toLetsFGPassenger),
      ...(this.client.environment === "sandbox" ? {
        sandbox: {
          scenario: offerContext.sandboxScenario || "success",
          speed: offerContext.sandboxSpeed || process.env.LETSFG_SANDBOX_SPEED || "fast",
        },
      } : {}),
    };
    const data = await this.client.request("POST", this.client.developerPath("flights/book"), payload);
    if (!data.booking_id) throw new Error("LetsFG booking response did not include booking_id.");
    return {
      status: data.state || "processing",
      supplierBookingRef: data.booking_id,
      raw: data,
    };
  }

  async getBooking(supplierBookingRef) {
    const data = await this.client.request("GET", this.client.developerPath(`flights/bookings/${encodeURIComponent(supplierBookingRef)}`));
    return {
      status: data.state,
      state: normalizeLetsFGState(data),
      terminal: Boolean(data.terminal),
      pnr: data.pnr || null,
      manualBooking: Boolean(data.manual_booking),
      question: data.question || null,
      heldAmount: data.held_amount ?? null,
      chargedAmount: data.charged_amount ?? null,
      currency: data.currency || null,
      failureReason: data.failure_reason || null,
      declineReason: data.decline_reason || null,
      raw: data,
    };
  }

  async answer(supplierBookingRef, answer) {
    const data = await this.client.request("POST", this.client.developerPath(`flights/bookings/${encodeURIComponent(supplierBookingRef)}/answer`), answer);
    return { status: data.status || "accepted", raw: data };
  }

  async stop(supplierBookingRef) {
    const data = await this.client.request("POST", this.client.developerPath(`flights/bookings/${encodeURIComponent(supplierBookingRef)}/stop`), {});
    return { status: data.status, raw: data };
  }

}


// LetsFG state -> TAPI's normalised live state. Only a completed booking WITH a
// PNR is 'confirmed'; the decision layer re-checks the evidence.
function normalizeLetsFGState(data) {
  switch (data.state) {
    case "completed": return "confirmed";
    case "failed": return "failed";
    case "needs_attention": return "needs_attention";
    default: return "in_progress"; // authorised, card_issued, booking_in_progress, awaiting_settlement, unknown...
  }
}

function encodeSandboxSnapshot(offers) {
  let list = offers;
  let encoded = Buffer.from(JSON.stringify({ status: "completed", offers: list })).toString("base64url");
  while (encoded.length > MAX_SANDBOX_SNAPSHOT_CHARS && list.length > 1) {
    list = list.slice(0, Math.max(1, Math.floor(list.length / 2)));
    encoded = Buffer.from(JSON.stringify({ status: "completed", offers: list })).toString("base64url");
  }
  if (encoded.length > MAX_SANDBOX_SNAPSHOT_CHARS) throw new Error("LetsFG sandbox search snapshot is too large to store.");
  return encoded;
}

function toLetsFGPassenger(p) {
  const value = {
    given_name: p.firstName,
    family_name: p.lastName,
    born_on: p.dateOfBirth,
    ...(p.gender ? { gender: p.gender } : {}),
    ...(p.email ? { email: p.email } : {}),
    ...(p.phoneNumber ? { phone_number: p.phoneNumber } : {}),
    ...(p.phoneCountry ? { phone_country: p.phoneCountry } : {}),
    ...(p.nationality ? { nationality: p.nationality } : {}),
    ...(p.passengerType ? { passenger_type: p.passengerType } : {}),
    ...(p.addressLine1 ? { address_line1: p.addressLine1 } : {}),
    ...(p.addressCity ? { address_city: p.addressCity } : {}),
    ...(p.addressPostal ? { address_postal: p.addressPostal } : {}),
    ...(p.addressCountry ? { address_country: p.addressCountry } : {}),
    ...(p.passportNumber ? { passport_number: p.passportNumber } : {}),
    ...(p.passportCountry ? { passport_country: p.passportCountry } : {}),
    ...(p.passportExpiry ? { passport_expiry: p.passportExpiry } : {}),
    ...(p.passportIssueDate ? { passport_issue: p.passportIssueDate } : {}),
  };
  return value;
}

function normalizeOffer(raw, supplierSearchId) {
  const price = raw.price ?? raw.total_price ?? raw.amount ?? raw.price_amount;
  const currency = raw.currency || raw.ccy || raw.price_currency || "USD";
  const offer = {
    supplierOfferRef: raw.offer_id || raw.id,
    supplierSearchId: supplierSearchId || raw.search_id,
    airline: raw.airline || raw.carrier || raw.airline_name || raw.owner,
    price,
    currency,
    outbound: raw.outbound || raw.itineraries?.[0] || raw.segments || null,
    inbound: raw.inbound || raw.itineraries?.[1] || null,
    stops: raw.stops ?? raw.stop_count ?? null,
    baggage: raw.baggage || raw.baggage_allowance || null,
    expiresAt: raw.expires_at || raw.expiry || new Date(Date.now() + 5 * 60_000).toISOString(),
    bookingUrl: raw.booking_url || null,
    sourceTier: raw.source_tier || null,
    rawSupplierOffer: raw,
  };
  if (!offer.supplierOfferRef) throw new Error("LetsFG returned an offer without an id.");
  return offer;
}

module.exports = { LetsFGAdapter, normalizeOffer, toLetsFGPassenger, normalizeLetsFGState, encodeSandboxSnapshot, SANDBOX_RESULT_PREFIX, MAX_SANDBOX_SNAPSHOT_CHARS };
