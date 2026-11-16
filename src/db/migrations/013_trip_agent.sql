-- Sprint 8: TAPI Agent trip memory. Every table is agency-scoped (tenant
-- boundary, same rule as 001_init). Identity data stays in `travelers`;
-- nothing here stores passport or contact details.

CREATE TABLE agent_trips (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id     UUID NOT NULL REFERENCES agencies(id),
  traveler_id   UUID REFERENCES travelers(id),
  title         TEXT NOT NULL,
  origin        TEXT,
  destination   TEXT,
  start_date    DATE,
  end_date      DATE,
  budget        NUMERIC(14,2),
  currency      TEXT,
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
    ('draft','researching','itinerary_ready','awaiting_approval','booking',
     'booked','partially_booked','needs_attention','cancelled','completed')),
  brief         JSONB NOT NULL DEFAULT '{}'::jsonb,   -- trip-specific preferences, never profile data
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_agent_trips_agency ON agent_trips(agency_id, status);

CREATE TABLE agent_trip_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id   UUID NOT NULL REFERENCES agencies(id),
  trip_id     UUID NOT NULL REFERENCES agent_trips(id),
  role        TEXT NOT NULL CHECK (role IN ('user','assistant','tool')),
  content     TEXT NOT NULL,                          -- already redacted before insert
  tool_trace  JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_agent_trip_messages_trip ON agent_trip_messages(trip_id, created_at);

-- One row per bookable piece of a trip. offer_id points at TAPI's own offers
-- (flights/hotels); the agent never stores supplier references of its own.
CREATE TABLE agent_trip_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id      UUID NOT NULL REFERENCES agencies(id),
  trip_id        UUID NOT NULL REFERENCES agent_trips(id),
  kind           TEXT NOT NULL CHECK (kind IN ('flight','hotel','bus','transfer','activity')),
  status         TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN
    ('proposed','selected','approved','booking','confirmed','action_required',
     'failed','reconciliation_required','cancelled')),
  offer_id       TEXT,
  booking_id     TEXT,                                -- TAPI booking id once booking starts
  quoted_price   NUMERIC(14,2),
  currency       TEXT,
  price_label    TEXT NOT NULL DEFAULT 'unverified' CHECK (price_label IN ('confirmed','estimated','unverified')),
  details        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_agent_trip_items_trip ON agent_trip_items(trip_id);

-- An approval authorises ONE booking of ONE offer at ONE price, once.
CREATE TABLE agent_trip_approvals (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id          UUID NOT NULL REFERENCES agencies(id),
  trip_id            UUID NOT NULL REFERENCES agent_trips(id),
  trip_item_id       UUID NOT NULL REFERENCES agent_trip_items(id),
  offer_id           TEXT NOT NULL,
  approved_price     NUMERIC(14,2) NOT NULL,
  currency           TEXT NOT NULL,
  tolerance_pct      NUMERIC(5,2) NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','consumed','expired','revoked')),
  expires_at         TIMESTAMPTZ NOT NULL,
  consumed_booking_id TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- At most one live approval per item: re-approving requires revoking the old one.
CREATE UNIQUE INDEX uq_agent_trip_approvals_active_item ON agent_trip_approvals(trip_item_id) WHERE status = 'active';

CREATE TABLE agent_trip_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id   UUID NOT NULL REFERENCES agencies(id),
  trip_id     UUID NOT NULL REFERENCES agent_trips(id),
  type        TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,   -- redacted
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_agent_trip_events_trip ON agent_trip_events(trip_id, created_at);
