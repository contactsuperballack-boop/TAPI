-- TAPI — beta-hardening review fixes.

-- #7: payment checkout URL was never persisted (same gap bookings.checkout_url
-- fixed in migration 004, missed here). Needed so a retried/stuck payment
-- initiation can return the URL without re-calling the provider.
ALTER TABLE payments ADD COLUMN checkout_url TEXT;

-- #9: store the provider's own event id once real providers are integrated,
-- so a duplicate webhook delivery can be detected by event id, not just by
-- payment status (belt-and-suspenders — status-based dedup already exists,
-- this is for when a real provider's event model is added).
ALTER TABLE payments ADD COLUMN provider_event_id TEXT;

-- #5: a supplier timeout during booking creation is not proof of failure —
-- the supplier may have accepted the booking but failed to respond. Marking
-- it 'failed' invites a client retry with a new idempotency key, which can
-- create a duplicate reservation and a duplicate charge. This state means
-- "we don't know what happened, don't assume, don't let it look resolved."
ALTER TABLE bookings DROP CONSTRAINT bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
  CHECK (status IN ('pending','confirmed','failed','cancelled','price_changed','action_required','reconciliation_required'));
