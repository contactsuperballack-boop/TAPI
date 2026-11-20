-- Sprint 10.4 — close the "supplier accepted, TAPI crashed" window and add a transactional outbox.
--
-- Submission intent: BEFORE calling a supplier, the booking records (in the same transaction that
-- moves it to 'pending') the server-owned submission key it is about to send and when. If the process
-- dies, a recovery worker can tell "pending and the call may have happened" from "pending and in flight".
-- Recovery NEVER blindly re-submits (passenger data is not kept for replay, and a duplicate ticket is worse
-- than a delayed one): it looks the booking up by key when the supplier supports that, otherwise it escalates
-- to reconciliation_required with the key recorded so a human can check the supplier.
ALTER TABLE bookings ADD COLUMN submission_key TEXT;
ALTER TABLE bookings ADD COLUMN submission_started_at TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN recovery_attempts INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_bookings_submission_orphans ON bookings(submission_started_at)
  WHERE status = 'pending' AND supplier_booking_id IS NULL;

-- Transactional outbox: events are inserted in the SAME transaction as the state change they describe, then
-- delivered at-least-once by a dispatcher. A crash between "state changed" and "tell someone" can no longer lose
-- the event. Consumers must be idempotent (dedupe_key is unique per logical event).
CREATE TABLE booking_outbox (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id    UUID NOT NULL REFERENCES bookings(id),
  agency_id     UUID,
  event_type    TEXT NOT NULL,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key    TEXT NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  available_at  TIMESTAMPTZ NOT NULL DEFAULT now(),   -- also the lease: claiming pushes this forward
  attempts      INTEGER NOT NULL DEFAULT 0,
  delivered_at  TIMESTAMPTZ,
  dead_at       TIMESTAMPTZ,                           -- gave up after max attempts; needs a human
  last_error    TEXT
);
CREATE INDEX idx_booking_outbox_pending ON booking_outbox(available_at)
  WHERE delivered_at IS NULL AND dead_at IS NULL;
