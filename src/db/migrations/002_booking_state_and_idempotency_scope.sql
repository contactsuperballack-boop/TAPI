-- TAPI — corrections identified in pre-hardening review (P0-3, P1-5).

-- P0-3: a book() call succeeding at the HTTP level is not the same as a
-- confirmed reservation. Add explicit states for supplier flows that don't
-- resolve synchronously (e.g. LetsFG's booking_url handoff — see
-- letsfgAdapter.js header) so the booking table can represent reality
-- instead of forcing everything into pending/confirmed/failed.
ALTER TABLE bookings DROP CONSTRAINT bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
  CHECK (status IN ('pending','confirmed','failed','cancelled','price_changed','action_required'));

-- P1-5: idempotency keys are only meaningful within a tenant. A global
-- UNIQUE constraint means two different agencies who happen to generate the
-- same key (or a naive client using "1") collide with each other's bookings.
ALTER TABLE bookings DROP CONSTRAINT bookings_idempotency_key_key;
ALTER TABLE bookings ADD CONSTRAINT bookings_agency_idempotency_key_unique
  UNIQUE (agency_id, idempotency_key);
