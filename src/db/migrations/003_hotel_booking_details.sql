-- TAPI — hotel booking details (Sprint 2, T-057).
-- The generic `bookings` table already covers status/idempotency/supplier
-- reference for any product type. This table holds the fields that are
-- hotel-specific and need to be independently queryable for reconciliation
-- — e.g. "which bookings have a balance due in the next 48 hours" — rather
-- than buried in supplier_bookings.raw_response jsonb.

CREATE TABLE hotel_booking_details (
  booking_id              UUID PRIMARY KEY REFERENCES bookings(id),
  confirmation_number     TEXT,
  guests                  JSONB,
  pay_link                TEXT,                 -- where the 95% balance is paid, direct to the hotel
  balance_due_by          TIMESTAMPTZ,           -- hotel's own auto-cancel deadline
  cancellation_terms      JSONB,
  reservation_fee_amount  NUMERIC(12,2),         -- the 5% charged immediately, non-refundable
  reservation_fee_status  TEXT CHECK (reservation_fee_status IN ('pending','charged','failed')),
  supplier_job_ref        TEXT,                  -- LetsFG's booking_job_id, for polling before confirmation
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Reconciliation query surface (T-057, T-075): find bookings with a balance
-- coming due, or a reservation fee that never confirmed as charged.
CREATE INDEX idx_hotel_booking_details_balance_due ON hotel_booking_details(balance_due_by);
CREATE INDEX idx_hotel_booking_details_fee_status ON hotel_booking_details(reservation_fee_status);
