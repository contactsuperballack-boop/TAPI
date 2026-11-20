-- Sprint 10.7 — at most ONE live booking per offer.
--
-- The idempotency key is chosen by the CLIENT, so a client that retries an ambiguous booking with a NEW key would create
-- a second supplier booking for the same offer (a duplicate ticket). This index makes that impossible at the database:
-- while a booking for an offer is in any state that may correspond to a real supplier booking, another cannot be created.
-- A definitively failed or cancelled booking frees the offer for a retry.
--
-- If this fails on existing data, duplicates already exist: resolve them (cancel/refund the extra bookings) first.
CREATE UNIQUE INDEX uniq_live_booking_per_offer ON bookings(offer_id)
  WHERE status IN ('created', 'pending', 'processing', 'ticketing_pending', 'reconciliation_required', 'confirmed');
