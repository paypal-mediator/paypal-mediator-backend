-- Reverses mediation-owned tables. Export case records first if they must be kept.
-- Stop MEDIATION_WORKER_ENABLED and deploy a compatible API before running.
-- M09 audit history remains append-only; its M07 vocabulary must remain supported.
BEGIN;
DROP TABLE mediation_deliveries;
DROP TABLE mediation_actions;
DROP TABLE mediation_messages;
DROP TABLE mediation_transitions;
DROP TABLE mediation_cases;
DROP TABLE mediation_policies;
DROP FUNCTION reject_mediation_history_mutation();
COMMIT;
