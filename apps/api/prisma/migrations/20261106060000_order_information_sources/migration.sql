CREATE TABLE "order_source_jobs" (
  "id" UUID NOT NULL, "merchant_id" UUID NOT NULL, "transaction_id" UUID NOT NULL,
  "provider_id" VARCHAR(64) NOT NULL, "source_kind" TEXT NOT NULL, "source_system" VARCHAR(255) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING', "attempts" INTEGER NOT NULL DEFAULT 0,
  "lease_token" UUID, "lease_expires_at" TIMESTAMPTZ(3), "next_attempt_at" TIMESTAMPTZ(3),
  "last_checked_at" TIMESTAMPTZ(3), "last_succeeded_at" TIMESTAMPTZ(3), "error_code" VARCHAR(128),
  "http_status" INTEGER, "evidence_id" UUID, "normalized" JSONB, "content_hash" VARCHAR(64),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "order_source_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "order_source_jobs_source_check" CHECK ("source_kind" IN ('PAYPAL','CONNECTED_SYSTEM')),
  CONSTRAINT "order_source_jobs_provider_check" CHECK ("provider_id" ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  CONSTRAINT "order_source_jobs_state_check" CHECK ("status" IN ('PENDING','FETCHING','COMPLETE','PARTIAL','CONFLICT','FAILED','NOT_CONFIGURED')),
  CONSTRAINT "order_source_jobs_attempts_check" CHECK ("attempts">=0),
  CONSTRAINT "order_source_jobs_lease_check" CHECK (("status"='FETCHING') = ("lease_token" IS NOT NULL AND "lease_expires_at" IS NOT NULL)),
  CONSTRAINT "order_source_jobs_hash_check" CHECK ("content_hash" IS NULL OR "content_hash" ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX "order_source_jobs_transaction_id_provider_id_key" ON "order_source_jobs"("transaction_id","provider_id");
CREATE INDEX "order_source_jobs_merchant_id_status_next_attempt_at_idx" ON "order_source_jobs"("merchant_id","status","next_attempt_at");
ALTER TABLE "order_source_jobs" ADD CONSTRAINT "order_source_jobs_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_source_jobs" ADD CONSTRAINT "order_source_jobs_transaction_id_merchant_id_fkey" FOREIGN KEY ("transaction_id","merchant_id") REFERENCES "transactions"("id","merchant_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_source_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "evidence_items" DROP CONSTRAINT "evidence_items_type_check";
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_type_check" CHECK ("type" IN ('PAYMENT_RECORD','ORDER_RECORD','TRACKING','PROOF_OF_DELIVERY','DOCUMENT','ORDER_SOURCE_RECORD'));
ALTER TABLE "evidence_items" DROP CONSTRAINT "evidence_items_source_check";
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_source_check" CHECK ("source_kind" IN ('PAYPAL','MERCHANT_INPUT','DEMO','CONNECTED_SYSTEM'));
ALTER TABLE "evidence_items" DROP CONSTRAINT IF EXISTS "evidence_items_provenance_type_check";
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_provenance_type_check" CHECK (
  ("type"='PAYMENT_RECORD' AND "source_kind"='PAYPAL') OR
  ("type"='ORDER_SOURCE_RECORD' AND "source_kind" IN ('PAYPAL','CONNECTED_SYSTEM')) OR
  ("type"='ORDER_RECORD' AND "source_kind" IN ('PAYPAL','CONNECTED_SYSTEM','MERCHANT_INPUT','DEMO')) OR
  ("type" IN ('TRACKING','PROOF_OF_DELIVERY','DOCUMENT') AND "source_kind" IN ('MERCHANT_INPUT','DEMO'))
);
