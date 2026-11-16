-- Sprint 9 / step 2: fulfilment modes and the agent queue.
-- A trip item is booked either 'automated' (TAPI sends it to a supplier API) or 'agent_assisted'
-- (a human agent completes it and records the confirmation). Money collection is NOT handled here (step 3).

-- Widen the item status list. The original CHECK was unnamed, so find it by its definition.
DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'agent_trip_items'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%proposed%';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE agent_trip_items DROP CONSTRAINT %I', c); END IF;
END $$;
ALTER TABLE agent_trip_items ADD CONSTRAINT ck_agent_trip_items_status CHECK (status IN
  ('proposed','selected','approved','agent_requested','agent_working','booking','confirmed',
   'action_required','failed','reconciliation_required','cancelled'));
ALTER TABLE agent_trip_items ADD COLUMN fulfilment_mode TEXT NOT NULL DEFAULT 'automated' CHECK (fulfilment_mode IN ('automated','agent_assisted'));
ALTER TABLE agent_trip_items ADD COLUMN confirmation_ref TEXT;

CREATE TABLE fulfilment_requests (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id             UUID NOT NULL REFERENCES agencies(id),
  trip_id               UUID NOT NULL REFERENCES agent_trips(id),
  trip_item_id          UUID NOT NULL REFERENCES agent_trip_items(id),
  approval_id           UUID NOT NULL REFERENCES agent_trip_approvals(id),
  status                TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','claimed','completed','declined','cancelled')),
  requested_by_user_id  UUID REFERENCES users(id),
  requested_by_role     TEXT,
  traveller_note        TEXT,
  approved_price        NUMERIC(14,2) NOT NULL,          -- ceiling the agent may not exceed
  currency              TEXT NOT NULL,
  claimed_by_user_id    UUID REFERENCES users(id),
  claimed_at            TIMESTAMPTZ,
  confirmation_ref      TEXT,
  final_price           NUMERIC(14,2),
  agent_note            TEXT,
  decline_reason        TEXT,
  completed_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_fulfilment_queue ON fulfilment_requests(agency_id, status, created_at);
CREATE INDEX idx_fulfilment_trip ON fulfilment_requests(trip_id);
-- At most one live request per item.
CREATE UNIQUE INDEX uq_fulfilment_active_item ON fulfilment_requests(trip_item_id) WHERE status IN ('open','claimed');
