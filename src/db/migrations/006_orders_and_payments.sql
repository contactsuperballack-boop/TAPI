-- TAPI — Orders & Payments (Sprint 4, T-070 through T-076).

-- T-071: "Supplier cost, agency markup, service fee and customer total must
-- be separately represented" — previously only total_price existed.
ALTER TABLE orders ADD COLUMN supplier_cost NUMERIC(12,2);
ALTER TABLE orders ADD COLUMN markup_amount NUMERIC(12,2);
ALTER TABLE orders ADD COLUMN service_fee NUMERIC(12,2);
ALTER TABLE orders ADD COLUMN tax_amount NUMERIC(12,2);
ALTER TABLE orders ADD COLUMN idempotency_key TEXT;
ALTER TABLE orders ADD CONSTRAINT orders_agency_idempotency_key_unique UNIQUE (agency_id, idempotency_key);

-- Payments: denormalize agency_id for direct tenant scoping (previously only
-- reachable via a join through orders), and add idempotency for pay-initiation
-- plus a uniqueness guard against a provider webhook being processed twice.
ALTER TABLE payments ADD COLUMN agency_id UUID REFERENCES agencies(id);
ALTER TABLE payments ADD COLUMN idempotency_key TEXT;
ALTER TABLE payments ADD CONSTRAINT payments_agency_idempotency_key_unique UNIQUE (agency_id, idempotency_key);
-- provider_ref uniqueness (where present) — prevents a retried/duplicate
-- webhook delivery from creating a second payment row for the same charge.
CREATE UNIQUE INDEX idx_payments_provider_ref_unique ON payments(provider, provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX idx_payments_agency ON payments(agency_id);

-- Which bookings compose an order needs to be queryable directly (previously
-- only bookings.order_id -> orders existed, one-directional and fine for
-- "what order is this booking in", but reconciliation needs "what bookings
-- are in this order" without a full table scan).
CREATE INDEX idx_bookings_order ON bookings(order_id);
