-- Sprint 10.6 — append-only money ledger, FX quotes, authorise/capture settlement.
--
-- ledger_entries is the source of truth for "who owes whom": append-only (a trigger rejects UPDATE/DELETE), every
-- entry has a globally unique idempotency key so a retried capture/void/refund can never be recorded twice.
-- Balances are DERIVED from completed entries; payments.*_minor are a cache updated in the same transaction.

CREATE TABLE ledger_entries (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id        UUID REFERENCES agencies(id),
  order_id         UUID,
  payment_id       UUID NOT NULL REFERENCES payments(id),
  booking_id       UUID,
  kind             TEXT NOT NULL CHECK (kind IN (
                     'authorization',
                     'capture_requested', 'capture', 'capture_failed',
                     'void_requested', 'void', 'void_failed',
                     'refund_requested', 'refund', 'refund_failed')),
  amount_minor     BIGINT NOT NULL CHECK (amount_minor >= 0),
  currency         TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL UNIQUE,
  provider_ref     TEXT,
  detail           JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ledger_payment ON ledger_entries(payment_id);
CREATE INDEX idx_ledger_order ON ledger_entries(order_id);

CREATE FUNCTION ledger_entries_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only (% rejected)', TG_OP;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_entries_no_update BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_immutable();

ALTER TABLE payments ADD COLUMN capture_mode TEXT NOT NULL DEFAULT 'automatic' CHECK (capture_mode IN ('automatic', 'manual'));
ALTER TABLE payments ADD COLUMN authorized_minor BIGINT NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN captured_minor BIGINT NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN voided_minor BIGINT NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN refunded_minor BIGINT NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN authorization_expires_at TIMESTAMPTZ;
ALTER TABLE payments DROP CONSTRAINT payments_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_status_check
  CHECK (status IN ('pending', 'authorized', 'captured', 'capture_failed', 'voided', 'failed', 'refunded', 'disputed'));

-- FX quotes: a locked rate (+ protective buffer) with a short life, usable exactly once.
CREATE TABLE fx_quotes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id       UUID NOT NULL REFERENCES agencies(id),
  base_currency   TEXT NOT NULL,
  quote_currency  TEXT NOT NULL,
  mid_rate        NUMERIC(24,10) NOT NULL CHECK (mid_rate > 0),
  buffer_bps      INTEGER NOT NULL CHECK (buffer_bps BETWEEN 0 AND 1000),
  source          TEXT NOT NULL,
  as_of           TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  consumed_at     TIMESTAMPTZ,
  consumed_by     TEXT,
  CHECK (base_currency <> quote_currency)
);
CREATE INDEX idx_fx_quotes_agency ON fx_quotes(agency_id, created_at DESC);

-- Backfill: payments captured/refunded BEFORE this migration get matching ledger entries and counters, so balances
-- derived from the ledger agree with history. (Exponent table mirrors src/domain/money.js.)
UPDATE payments SET captured_minor = ROUND(amount * power(10,
    CASE WHEN currency IN ('JPY','KRW','UGX','VND','XOF','XAF','RWF','CLP') THEN 0
         WHEN currency IN ('KWD','BHD','JOD','OMR','TND') THEN 3 ELSE 2 END))::bigint
  WHERE status IN ('captured', 'refunded', 'disputed');
UPDATE payments SET refunded_minor = captured_minor WHERE status = 'refunded';
INSERT INTO ledger_entries (agency_id, order_id, payment_id, kind, amount_minor, currency, idempotency_key, provider_ref, detail)
  SELECT agency_id, order_id, id, 'capture', captured_minor, currency, 'backfill-capture:' || id, provider_ref, '{"backfill":true}'::jsonb
  FROM payments WHERE captured_minor > 0;
INSERT INTO ledger_entries (agency_id, order_id, payment_id, kind, amount_minor, currency, idempotency_key, provider_ref, detail)
  SELECT agency_id, order_id, id, 'refund', refunded_minor, currency, 'backfill-refund:' || id, provider_ref, '{"backfill":true}'::jsonb
  FROM payments WHERE refunded_minor > 0;
