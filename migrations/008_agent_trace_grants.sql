-- Repair app-role access for agent provenance and recall trace tables.
-- Migration 005 created these tables but did not grant runtime privileges.
GRANT SELECT, INSERT, UPDATE ON agents TO total_recall_app;
GRANT SELECT, INSERT ON recall_traces TO total_recall_app;
