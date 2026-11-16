-- TAPI — initial schema (T-010, T-012, T-013)
-- Clean-database migration from zero. No manual schema setup (T-011).

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Agencies are the tenant boundary. Every downstream table is scoped to one.
CREATE TABLE agencies (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- API clients / keys issued to an agency (T-020, credential rotation/revocation).
CREATE TABLE api_clients (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id       UUID NOT NULL REFERENCES agencies(id),
  key_hash        TEXT NOT NULL UNIQUE,       -- hash of the API key, never store plaintext
  label           TEXT,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ
);
CREATE INDEX idx_api_clients_agency ON api_clients(agency_id);

CREATE TABLE customers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id       UUID NOT NULL REFERENCES agencies(id),
  full_name       TEXT NOT NULL,
  email           TEXT,
  phone           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_customers_agency ON customers(agency_id);

CREATE TABLE travelers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id       UUID NOT NULL REFERENCES agencies(id),
  customer_id     UUID REFERENCES customers(id),
  first_name      TEXT NOT NULL,
  last_name       TEXT NOT NULL,
  date_of_birth   DATE,
  passport_number TEXT,
  nationality     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_travelers_agency ON travelers(agency_id);

-- Async search jobs (T-043).
CREATE TABLE searches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id       UUID NOT NULL REFERENCES agencies(id),
  type            TEXT NOT NULL CHECK (type IN ('flight','hotel')),
  status          TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','completed','failed')),
  criteria        JSONB NOT NULL,
  supplier_search_ref TEXT,                  -- LetsFG's own search_id, internal only
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_searches_agency ON searches(agency_id);
CREATE INDEX idx_searches_status ON searches(status);

-- Normalized, cached offers. Not the source of truth — expires.
CREATE TABLE offers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  search_id       UUID NOT NULL REFERENCES searches(id),
  agency_id       UUID NOT NULL REFERENCES agencies(id),
  type            TEXT NOT NULL CHECK (type IN ('flight','hotel')),
  supplier_code   TEXT NOT NULL,              -- e.g. 'letsfg' — internal only, never exposed publicly
  supplier_offer_ref TEXT NOT NULL,           -- supplier's own offer id, internal only
  price           NUMERIC(12,2) NOT NULL,
  currency        TEXT NOT NULL,
  payload         JSONB NOT NULL,             -- normalized offer (airline, segments, baggage, etc.)
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (supplier_code, supplier_offer_ref)
);
CREATE INDEX idx_offers_search ON offers(search_id);
CREATE INDEX idx_offers_expires ON offers(expires_at);

CREATE TABLE orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id       UUID NOT NULL REFERENCES agencies(id),
  customer_id     UUID REFERENCES customers(id),
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','cancelled')),
  total_price     NUMERIC(12,2),
  currency        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_orders_agency ON orders(agency_id);

-- Internal, immutable booking record. Source of truth for our side of the transaction.
CREATE TABLE bookings (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id           UUID NOT NULL REFERENCES agencies(id),
  order_id            UUID REFERENCES orders(id),
  offer_id            UUID NOT NULL REFERENCES offers(id),
  type                TEXT NOT NULL CHECK (type IN ('flight','hotel')),
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','confirmed','failed','cancelled','price_changed')),
  idempotency_key     TEXT NOT NULL UNIQUE,      -- T-074, prevents duplicate supplier mutations
  supplier_code       TEXT NOT NULL,
  supplier_reference  TEXT,                       -- PNR / confirmation number once confirmed
  traveler_ids        UUID[] NOT NULL,
  correlation_id      TEXT,                       -- ties request -> supplier call -> response for debugging
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_bookings_agency ON bookings(agency_id);
CREATE INDEX idx_bookings_status ON bookings(status);
CREATE INDEX idx_bookings_supplier_ref ON bookings(supplier_reference);

-- Raw supplier audit trail, kept separate from the clean internal booking record (T-034).
CREATE TABLE supplier_bookings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id      UUID NOT NULL REFERENCES bookings(id),
  supplier_code   TEXT NOT NULL,
  raw_request     JSONB,
  raw_response    JSONB,
  supplier_status TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_supplier_bookings_booking ON supplier_bookings(booking_id);

CREATE TABLE payments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        UUID NOT NULL REFERENCES orders(id),
  provider        TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending','authorized','captured','failed','refunded','disputed')),
  amount          NUMERIC(12,2) NOT NULL,
  currency        TEXT NOT NULL,
  provider_ref    TEXT,
  webhook_verified_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_payments_order ON payments(order_id);

CREATE TABLE audit_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id       UUID REFERENCES agencies(id),
  actor           TEXT,                 -- api_client id or 'system'
  action          TEXT NOT NULL,
  resource_type   TEXT NOT NULL,
  resource_id     UUID,
  metadata        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_agency ON audit_events(agency_id);
CREATE INDEX idx_audit_created ON audit_events(created_at);
