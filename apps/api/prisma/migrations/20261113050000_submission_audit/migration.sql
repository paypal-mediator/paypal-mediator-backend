ALTER TABLE audit_events DROP CONSTRAINT audit_events_module_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_module_check
CHECK (module IN ('M01','M02','M03','M04','M05','M06','M07','M08'));
