ALTER TABLE "ingestion_jobs" ADD COLUMN "finished_at" TIMESTAMPTZ(3), ADD COLUMN "error_code" VARCHAR(64);
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_status_check" CHECK ("status" IN ('QUEUED', 'COMPLETED', 'FAILED'));

CREATE TABLE "transactions" (
  "id" UUID NOT NULL,
  "merchant_id" UUID NOT NULL,
  "environment" TEXT NOT NULL DEFAULT 'sandbox',
  "paypal_capture_id" VARCHAR(255) NOT NULL,
  "paypal_order_id" VARCHAR(255),
  "merchant_order_reference" VARCHAR(255),
  "invoice_id" VARCHAR(255),
  "status" TEXT NOT NULL DEFAULT 'COMPLETED',
  "currency_code" VARCHAR(3) NOT NULL,
  "amount" DECIMAL(24,8) NOT NULL,
  "captured_at" TIMESTAMPTZ(3) NOT NULL,
  "source_event_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "transactions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transactions_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "transactions_source_event_id_fkey" FOREIGN KEY ("source_event_id") REFERENCES "webhook_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "transactions_sandbox_check" CHECK ("environment" = 'sandbox'),
  CONSTRAINT "transactions_status_check" CHECK ("status" = 'COMPLETED'),
  CONSTRAINT "transactions_positive_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "transactions_currency_check" CHECK ("currency_code" ~ '^[A-Z]{3}$')
);
CREATE UNIQUE INDEX "transactions_source_event_id_key" ON "transactions"("source_event_id");
CREATE UNIQUE INDEX "transactions_merchant_id_environment_paypal_capture_id_key" ON "transactions"("merchant_id", "environment", "paypal_capture_id");
CREATE INDEX "transactions_merchant_id_created_at_id_idx" ON "transactions"("merchant_id", "created_at", "id");
ALTER TABLE "transactions" ENABLE ROW LEVEL SECURITY;
