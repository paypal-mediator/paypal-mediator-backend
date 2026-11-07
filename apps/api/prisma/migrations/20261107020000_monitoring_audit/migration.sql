CREATE TABLE "audit_events" (
  "id" UUID NOT NULL,
  "merchant_id" UUID NOT NULL,
  "actor_user_id" UUID NOT NULL,
  "record" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "audit_events_merchant_id_created_at_id_idx"
  ON "audit_events"("merchant_id", "created_at", "id");
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$;
CREATE TRIGGER audit_events_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON "audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
