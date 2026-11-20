-- Sprint 10.0 — supplier-agnostic flights + durable booking polling.
--
-- 1. searches.supplier_code: until now a search never recorded WHICH supplier
--    ran it; routes assumed 'letsfg'. A second supplier (Tiqwa) makes that
--    ambiguous, so it is stored explicitly. Existing rows were all LetsFG.
-- 2. bookings polling bookkeeping: lets a background worker poll asynchronous
--    supplier bookings with backoff instead of relying on a client calling GET.
-- 3. bookings.status gains 'ticketing_pending' (reservation held, ticket not
--    issued) for GDS-style suppliers. It must never be presented as booked.

ALTER TABLE searches ADD COLUMN supplier_code TEXT NOT NULL DEFAULT 'letsfg';

-- supplier_booking_id: the supplier's own booking/order id, used for polling, answers and stop.
-- supplier_reference keeps meaning "evidence reference" (PNR / ticket number once confirmed).
-- Previously confirming a booking overwrote the supplier's booking id with the PNR.
ALTER TABLE bookings ADD COLUMN supplier_booking_id TEXT;
UPDATE bookings SET supplier_booking_id = supplier_reference
  WHERE supplier_reference IS NOT NULL AND type = 'flight'
    AND status IN ('pending', 'processing', 'reconciliation_required');

ALTER TABLE bookings ADD COLUMN poll_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN last_polled_at TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN next_poll_at TIMESTAMPTZ;

ALTER TABLE bookings DROP CONSTRAINT bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
  CHECK (status IN (
    'created', 'pending', 'processing', 'ticketing_pending', 'confirmed',
    'action_required', 'price_changed',
    'failed', 'reconciliation_required',
    'cancel_requested', 'cancelled',
    'refund_pending', 'refunded', 'refund_failed'
  ));

-- Worker query: asynchronous bookings that have a supplier reference and are due.
CREATE INDEX idx_bookings_poll_due ON bookings(next_poll_at)
  WHERE supplier_booking_id IS NOT NULL
    AND status IN ('pending', 'processing', 'ticketing_pending', 'reconciliation_required');
