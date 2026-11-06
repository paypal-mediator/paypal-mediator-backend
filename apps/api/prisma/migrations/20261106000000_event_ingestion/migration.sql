-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'sandbox',
    "paypal_event_id" VARCHAR(255) NOT NULL,
    "event_type" VARCHAR(128) NOT NULL,
    "event_created_at" TIMESTAMPTZ(3) NOT NULL,
    "webhook_id" TEXT NOT NULL,
    "transmission_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "raw_body" TEXT NOT NULL,
    "payload_hash" VARCHAR(64) NOT NULL,
    "raw_body_hash" VARCHAR(64) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingestion_jobs" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingestion_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webhook_events_merchant_id_received_at_idx" ON "webhook_events"("merchant_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_merchant_id_environment_paypal_event_id_key" ON "webhook_events"("merchant_id", "environment", "paypal_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "ingestion_jobs_event_id_key" ON "ingestion_jobs"("event_id");

-- CreateIndex
CREATE INDEX "ingestion_jobs_status_created_at_idx" ON "ingestion_jobs"("status", "created_at");

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "webhook_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_sandbox_check" CHECK ("environment" = 'sandbox');
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_kind_check" CHECK ("kind" IN ('TRANSACTION_CAPTURED', 'DISPUTE_CHANGED'));
ALTER TABLE "webhook_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ingestion_jobs" ENABLE ROW LEVEL SECURITY;
