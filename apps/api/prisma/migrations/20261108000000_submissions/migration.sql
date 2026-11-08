-- CreateTable
CREATE TABLE "submissions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchant_id" UUID NOT NULL,
    "dispute_id" UUID NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'sandbox',
    "paypal_request_id" VARCHAR(255),
    "status" VARCHAR(16) NOT NULL DEFAULT 'BLOCKED',
    "paypal_response_status" INTEGER,
    "submitted_at" TIMESTAMP(3),
    "error_code" VARCHAR(80),
    "error_message" VARCHAR(2000),
    "guard_verdict" VARCHAR(16) NOT NULL,
    "guard_reasons" JSONB NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submission_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "submission_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "event_type" VARCHAR(128) NOT NULL,
    "paypal_event_id" VARCHAR(255) NOT NULL,
    "outcome" VARCHAR(32) NOT NULL DEFAULT 'APPLIED',
    "reason" VARCHAR(64),
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "submission_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "submissions_idempotency_key_key" ON "submissions"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "submissions_merchant_id_dispute_id_key" ON "submissions"("merchant_id", "dispute_id");

-- CreateIndex
CREATE INDEX "submissions_merchant_id_created_at_id_idx" ON "submissions"("merchant_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "submission_events_event_id_key" ON "submission_events"("event_id");

-- CreateIndex
CREATE INDEX "submission_events_submission_id_occurred_at_id_idx" ON "submission_events"("submission_id", "occurred_at", "id");

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "disputes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_events" ADD CONSTRAINT "submission_events_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_events" ADD CONSTRAINT "submission_events_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "webhook_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
