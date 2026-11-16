-- Sprint 1 hardening: mobility_operations (migration 010) introduced its own
-- audit_logs table instead of reusing audit_events (migration 001), which the
-- rest of the app already writes to centrally via middleware/auditLog.js.
-- Result: two divergent, undocumented audit trails. Any future "all audit
-- activity for this agency" query against audit_events would silently miss
-- everything mobility did. Consolidating into the one table that already has
-- an established writer, index, and downstream expectations.
--
-- Schemas are identical in shape (agency_id, actor, action, resource_type,
-- resource_id, metadata, created_at), so this is a straight data copy, not a
-- transform. Safe to run even if audit_logs is empty (fresh/dev DBs).

INSERT INTO audit_events (id, agency_id, actor, action, resource_type, resource_id, metadata, created_at)
SELECT id, agency_id, actor, action, resource_type, resource_id, metadata, created_at
FROM audit_logs
ON CONFLICT (id) DO NOTHING;

DROP TABLE audit_logs;
