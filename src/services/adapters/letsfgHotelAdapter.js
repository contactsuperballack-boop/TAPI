// LetsFG hotel adapter — implements HotelSupplier against LetsFG's hotel API.
//
// CONFIRMED from LetsFG's own docs/README as of this writing:
//   - GET /developers/api/v1/hotels/booking/<id> — poll for confirmation and
//     pay link; "5% now, balance to the hotel."
//   - Hotels need a card on file for search AND booking (not just booking).
//   - Free-cancellation rates only: a small upfront charge (5%) holds the
//     room; the remaining 95% is never charged if you cancel before the
//     hotel's own deadline (balance_due_by) — it goes to the hotel directly
//     via a pay_link, not through LetsFG.
//   - "Confirm hotel rate before booking (required if rate_type=RECHECK)" —
//     i.e. validateOffer() is conditionally required depending on rate type,
//     not always optional.
//   - Auth: X-API-Key header (Developer API only — no PFS/free path exists
//     for hotels in LetsFG's public materials at time of writing; hotels
//     appear to be Developer-API-only, unlike flights' dual-path model).
//   - A "get guest voucher for hotel check-in" endpoint exists separately
//     from booking confirmation.
//   - A "cancel a hotel booking OR SIMULATE cancellation" endpoint exists —
//     the simulate mode is useful for showing a customer what they'd get
//     back before they commit to cancelling (T-056).
//
// !! UNVERIFIED — confirm against sandbox before Sprint 2 goes live (T-062) !!
// The exact paths for hotel destination resolution, search initiation, and
// the book() call itself are NOT confirmed from public docs at time of
// writing (only the booking *poll* path is). The paths below follow LetsFG's
// established /developers/api/v1/{product}/{action} convention from the
// flights side, but must be checked against actual sandbox responses before
// any real booking is attempted. Do not treat book()/search() as working.

const { HotelSupplier } = require("../hotelSupplier.interface");
const { LetsFGClient } = require("./letsfgClient");
const { Errors } = require("../../domain/errors");

class LetsFGHotelAdapter extends HotelSupplier {
  constructor(config) {
    super();
    if (config.environment === "sandbox") {
      throw new Error("LetsFG does not currently document a hotel sandbox. Hotel requests are blocked while LETSFG_ENVIRONMENT=sandbox to prevent accidental live calls.");
    }
    if (config.authMode !== "developer") {
      // See module header: hotels appear to be Developer-API-only. Fail
      // loudly rather than silently trying a PFS-style call that doesn't exist.
      throw new Error(
        "LetsFGHotelAdapter requires LETSFG_AUTH_MODE=developer — LetsFG's public docs show no free/PFS path for hotels."
      );
    }
    this.client = new LetsFGClient(config);
  }

  // --- UNVERIFIED (see header) --------------------------------------------
  async resolveDestination(query) {
    const data = await this.client.request("POST", "/developers/api/v1/hotels/locations", { query });
    return data.locations || [];
  }

  async search({ destination, checkIn, checkOut, adults, children, rooms, currency }) {
    const data = await this.client.request("POST", "/developers/api/v1/hotels/search/async", {
      destination,
      check_in: checkIn,
      check_out: checkOut,
      guests: { adults, children: children || 0 },
      rooms: rooms || 1,
      currency: currency || "USD",
    });
    return { supplierSearchRef: data.search_id };
  }

  async pollSearch(supplierSearchRef) {
    const data = await this.client.request("GET", `/developers/api/v1/hotels/search/${supplierSearchRef}`);
    return {
      status: data.status,
      offers: (data.offers || []).map(normalizeOffer),
    };
  }

  async getOffer(supplierOfferRef) {
    const data = await this.client.request("GET", `/developers/api/v1/hotels/offers/${supplierOfferRef}`);
    return normalizeOffer(data);
  }

  // CONFIRMED as a required step for rate_type=RECHECK offers; treated as
  // always-safe-to-call here since we can't yet distinguish rate types from
  // search results alone (see UNVERIFIED note on normalizeOffer's rateType field).
  async validateOffer(supplierOfferRef) {
    const data = await this.client.request("POST", `/developers/api/v1/hotels/offers/${supplierOfferRef}/recheck`);
    if (data.price_changed) throw Errors.PriceChanged(`Hotel offer ${supplierOfferRef} repriced by LetsFG`);
    if (data.sold_out) throw Errors.SoldOut();
    return { valid: true, offer: normalizeOffer(data.offer || data) };
  }

  // Async — book() only starts the job. Never retry blindly (LetsFG's own
  // warning: double-booking + double-charging the 5% reservation fee).
  // Idempotency at the TAPI layer (idempotency_key UNIQUE per agency) is
  // what actually prevents this — see routes/hotels.routes.js.
  async book(supplierOfferRef, guests, contact) {
    const data = await this.client.request("POST", "/developers/api/v1/hotels/bookings", {
      offer_id: supplierOfferRef,
      guests,
      contact,
    });
    return { supplierJobRef: data.booking_job_id || data.job_id, raw: data };
  }

  // CONFIRMED endpoint. Poll until status is 'succeeded'/'failed'.
  async getBooking(supplierJobOrBookingRef) {
    const data = await this.client.request("GET", `/developers/api/v1/hotels/booking/${supplierJobOrBookingRef}`);
    return {
      status: data.status, // 'processing' | 'succeeded' | 'failed'
      confirmationNumber: data.confirmation_number,
      payLink: data.pay_link,
      balanceDueBy: data.balance_due_by,
      reservationFeeAmount: data.reservation_fee_amount,
      reservationFeeStatus: data.reservation_fee_status,
      cancellationTerms: data.cancellation_terms,
      raw: data,
    };
  }

  async getGuestVoucher(supplierBookingRef) {
    // CONFIRMED to exist as a distinct endpoint from booking status; exact
    // path unverified.
    return this.client.request("GET", `/developers/api/v1/hotels/booking/${supplierBookingRef}/voucher`);
  }

  async cancel(supplierBookingRef, { simulate = false } = {}) {
    // CONFIRMED: LetsFG supports a simulate mode for this endpoint, useful
    // for showing the customer what they'd get back before committing.
    const data = await this.client.request(
      "POST",
      `/developers/api/v1/hotels/booking/${supplierBookingRef}/cancel${simulate ? "?simulate=true" : ""}`
    );
    return { status: data.status, refundAmount: data.refund_amount, raw: data };
  }
}

function normalizeOffer(raw) {
  return {
    supplierOfferRef: raw.offer_id || raw.id,
    hotelName: raw.hotel_name || raw.name,
    price: raw.price,
    currency: raw.currency || "USD",
    checkIn: raw.check_in,
    checkOut: raw.check_out,
    roomType: raw.room_type,
    rateType: raw.rate_type, // e.g. 'RECHECK' — UNVERIFIED whether this is the actual field name
    cancellationPolicy: raw.cancellation_policy || null,
    expiresAt: raw.expires_at,
  };
}

module.exports = { LetsFGHotelAdapter };
