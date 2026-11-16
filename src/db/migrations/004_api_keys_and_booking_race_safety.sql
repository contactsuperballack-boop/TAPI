-- TAPI — API-key lifecycle + booking race-safety + checkout URL persistence.

-- API-key lifecycle: prefix for identification without exposing the secret,
-- expiration, and last-used tracking.
ALTER TABLE api_clients ADD COLUMN key_prefix TEXT;
ALTER TABLE api_clients ADD COLUMN expires_at TIMESTAMPTZ;
ALTER TABLE api_clients ADD COLUMN last_used_at TIMESTAMPTZ;
CREATE INDEX idx_api_clients_key_prefix ON api_clients(key_prefix);

-- Backfill: existing rows (e.g. from seed.js) get a synthetic prefix so the
-- column can be NOT NULL going forward for new rows. Existing raw keys are
-- unrecoverable by design (only the hash was ever stored), so this is just
-- a display placeholder, not a real prefix.
UPDATE api_clients SET key_prefix = 'tapi_legacy_' || substr(id::text, 1, 8) WHERE key_prefix IS NULL;
ALTER TABLE api_clients ALTER COLUMN key_prefix SET NOT NULL;

-- Booking race-safety: a request_hash lets us detect the same idempotency
-- key being reused with a materially different request body (a client bug,
-- not a legitimate retry) instead of silently returning a mismatched booking.
ALTER TABLE bookings ADD COLUMN request_hash TEXT;

-- Checkout-URL persistence: previously only returned in the immediate HTTP
-- response and never stored, so it vanished on any later GET/reconciliation.
ALTER TABLE bookings ADD COLUMN checkout_url TEXT;
