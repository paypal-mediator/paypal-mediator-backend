ALTER TABLE audit_events
  ALTER COLUMN actor_user_id DROP NOT NULL,
  ADD COLUMN actor_kind TEXT NOT NULL DEFAULT 'USER',
  ADD COLUMN module TEXT NOT NULL DEFAULT 'M01',
  ADD COLUMN action TEXT NOT NULL DEFAULT 'SETTINGS_UPDATED',
  ADD COLUMN outcome TEXT NOT NULL DEFAULT 'SUCCEEDED',
  ADD COLUMN transaction_id UUID,
  ADD COLUMN resource_type TEXT NOT NULL DEFAULT 'MERCHANT',
  ADD COLUMN resource_id UUID,
  ADD COLUMN duration_ms INTEGER,
  ADD COLUMN input_tokens INTEGER,
  ADD COLUMN output_tokens INTEGER,
  ADD CONSTRAINT audit_events_module_check CHECK (module IN ('M01','M02','M03','M04','M05','M06')),
  ADD CONSTRAINT audit_events_actor_check CHECK (actor_kind IN ('USER','SYSTEM','PAYPAL','AGENT')),
  ADD CONSTRAINT audit_events_outcome_check CHECK (outcome IN ('STARTED','SUCCEEDED','FAILED','BLOCKED','DUPLICATE','IGNORED')),
  ADD CONSTRAINT audit_events_counts_check CHECK (duration_ms >= 0 AND input_tokens >= 0 AND output_tokens >= 0);
CREATE INDEX audit_events_merchant_id_transaction_id_created_at_idx ON audit_events(merchant_id,transaction_id,created_at);
CREATE INDEX audit_events_merchant_id_resource_id_created_at_idx ON audit_events(merchant_id,resource_id,created_at);
