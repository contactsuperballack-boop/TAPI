-- TAPI — booking state machine hardening.
--
-- Merges the review's proposed state list with what already exists and is
-- meaningful (price_changed, action_required — real LetsFG behaviors, not
-- invented). Every transition between these states now goes through
-- domain/bookingStateMachine.js, which rejects invalid transitions and
-- enforces guard rules (e.g. can't reach 'confirmed' without a supplier
-- reference) — this migration just makes the schema itself permissive
-- enough to hold the full lifecycle; the application layer is what makes
-- transitions actually safe.

ALTER TABLE bookings DROP CONSTRAINT bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
  CHECK (status IN (
    'created', 'pending', 'processing', 'confirmed',
    'action_required', 'price_changed',
    'failed', 'reconciliation_required',
    'cancel_requested', 'cancelled',
    'refund_pending', 'refunded', 'refund_failed'
  ));

-- Every state transition is now recorded here, separate from the booking
-- row itself — this is what makes "manual operator intervention is
-- recorded and auditable" true rather than aspirational. actor is 'system'
-- for automated transitions, an api_client id for API-driven ones, or an
-- operator identifier for manual reconciliation (see RUNBOOK.md).
CREATE TABLE booking_state_transitions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id    UUID NOT NULL REFERENCES bookings(id),
  from_status   TEXT,
  to_status     TEXT NOT NULL,
  actor         TEXT NOT NULL DEFAULT 'system',
  reason        TEXT,
  metadata      JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_booking_state_transitions_booking ON booking_state_transitions(booking_id);
CREATE INDEX idx_booking_state_transitions_created ON booking_state_transitions(created_at);

-- Supports "a booking stuck in an intermediate state is automatically
-- detected" (domain/pricing... see scripts/reconcile.js) — needs an
-- efficient way to find bookings sitting in a non-terminal status for
-- longer than expected.
CREATE INDEX idx_bookings_status_updated ON bookings(status, updated_at);

-- Payment integrity (review §6): dedup on the provider's own event id, not
-- just local payment status — belt-and-suspenders against a duplicate
-- webhook delivery that somehow reaches two different payment rows (should
-- not happen given provider_ref uniqueness, but this closes the gap if it
-- ever does). provider_event_id column already existed (migration 007) but
-- nothing enforced uniqueness on it or actually populated it until now.
CREATE UNIQUE INDEX idx_payments_provider_event_id_unique
  ON payments(provider, provider_event_id) WHERE provider_event_id IS NOT NULL;
