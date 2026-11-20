-- When an approval was spent. Lets the executor bound the "consumed but no booking id" retry path
-- (crash/timeout recovery) to a short window, so a stale approval can never book unvalidated later.
ALTER TABLE agent_trip_approvals ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ;
