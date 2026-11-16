-- TAPI — Nigerian domestic supplier evaluation tracking (Backlog T-060, T-061).
-- This is deliberately NOT a supplier configuration table — it's a research
-- log. Nothing here makes a route "supported"; it exists so the Decision
-- Gate work (which candidate, sandbox access, coverage tests, booking
-- tests) has somewhere real to be recorded before any adapter code is
-- written, instead of living in a spreadsheet disconnected from the schema
-- that will eventually reference it.

CREATE TABLE domestic_supplier_candidates (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                    TEXT NOT NULL,
  api_docs_url            TEXT,
  contact_notes           TEXT,

  -- T-062: sandbox/test access. No route is considered supported without this.
  has_sandbox_access      BOOLEAN NOT NULL DEFAULT false,
  sandbox_access_notes    TEXT,

  -- T-063: search coverage tests — record route/date/airline/fare/result, not just a pass/fail
  coverage_test_status    TEXT NOT NULL DEFAULT 'not_started'
                            CHECK (coverage_test_status IN ('not_started','in_progress','passed','failed')),
  coverage_test_notes     TEXT,

  -- T-064: actual booking lifecycle test on representative routes
  booking_test_status     TEXT NOT NULL DEFAULT 'not_started'
                            CHECK (booking_test_status IN ('not_started','in_progress','passed','failed')),
  booking_test_notes      TEXT,

  -- Commercial terms — separate from technical readiness; both must clear
  -- the Decision Gate before T-065 (adapter implementation) can start.
  commercial_terms_status TEXT NOT NULL DEFAULT 'not_started'
                            CHECK (commercial_terms_status IN ('not_started','negotiating','agreed','rejected')),
  commercial_terms_notes  TEXT,

  evaluated_by            TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A candidate is only ready for T-065 (real adapter implementation) once all
-- three tracks have cleared. This view exists so "are we ready to build
-- this" is a query, not a meeting.
CREATE VIEW domestic_supplier_ready_for_implementation AS
  SELECT * FROM domestic_supplier_candidates
  WHERE has_sandbox_access = true
    AND coverage_test_status = 'passed'
    AND booking_test_status = 'passed'
    AND commercial_terms_status = 'agreed';
