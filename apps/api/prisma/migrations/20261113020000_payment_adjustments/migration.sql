-- M02: index verified capture identities for refund routing without reading M03 tables.
ALTER TABLE "webhook_events" ADD COLUMN "paypal_resource_id" VARCHAR(255);
UPDATE "webhook_events" SET "paypal_resource_id" = "payload" #>> '{resource,id}'
WHERE jsonb_typeof("payload" #> '{resource,id}') = 'string'
  AND length("payload" #>> '{resource,id}') <= 255;
CREATE INDEX "webhook_events_event_type_paypal_resource_id_environment_idx"
  ON "webhook_events"("event_type", "paypal_resource_id", "environment");
ALTER TABLE "ingestion_jobs" DROP CONSTRAINT "ingestion_jobs_kind_check";
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_kind_check"
  CHECK ("kind" IN ('TRANSACTION_CAPTURED', 'DISPUTE_CHANGED', 'PAYMENT_ADJUSTED'));
-- Previously ignored, verified refunds/reversals are now eligible for processing.
INSERT INTO "ingestion_jobs" ("id", "event_id", "kind")
SELECT gen_random_uuid(), e."id", 'PAYMENT_ADJUSTED' FROM "webhook_events" e
WHERE e."event_type" IN ('PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED')
ON CONFLICT ("event_id") DO NOTHING;

-- M03: original capture amounts stay immutable; returned money is a separate projection.
ALTER TABLE "transactions"
  ADD COLUMN "returned_amount" DECIMAL(38,8) NOT NULL DEFAULT 0,
  ADD COLUMN "adjustment_review_required" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_status_check";
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_status_check"
  CHECK ("status" IN ('COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'PARTIALLY_REVERSED', 'REVERSED', 'NEEDS_REVIEW'));
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_returned_amount_check"
  CHECK ("returned_amount" >= 0 AND ("adjustment_review_required" OR "returned_amount" <= "amount"));

CREATE TABLE "payment_adjustments" (
  "id" UUID NOT NULL PRIMARY KEY,
  "merchant_id" UUID NOT NULL REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "environment" TEXT NOT NULL DEFAULT 'sandbox' CHECK ("environment" = 'sandbox'),
  "paypal_capture_id" VARCHAR(255) NOT NULL,
  "paypal_adjustment_id" VARCHAR(255) NOT NULL,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('REFUND', 'REVERSAL')),
  "currency_code" VARCHAR(3) NOT NULL CHECK ("currency_code" ~ '^[A-Z]{3}$'),
  "amount" DECIMAL(24,8) NOT NULL CHECK ("amount" > 0),
  "cumulative_returned_amount" DECIMAL(24,8) CHECK ("cumulative_returned_amount" >= "amount"),
  "occurred_at" TIMESTAMPTZ(3) NOT NULL,
  "source_event_id" UUID NOT NULL REFERENCES "webhook_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "payment_adjustments_source_event_id_key" ON "payment_adjustments"("source_event_id");
CREATE UNIQUE INDEX "payment_adjustments_merchant_env_adjustment_key"
  ON "payment_adjustments"("merchant_id", "environment", "paypal_adjustment_id");
CREATE INDEX "payment_adjustments_merchant_env_capture_idx"
  ON "payment_adjustments"("merchant_id", "environment", "paypal_capture_id");
ALTER TABLE "payment_adjustments" ENABLE ROW LEVEL SECURITY;
