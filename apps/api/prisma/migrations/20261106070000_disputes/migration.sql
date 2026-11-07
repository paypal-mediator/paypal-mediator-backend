-- M07 stores dispute orchestration state. PayPal status/stage stay immutable
-- inputs; internal_state is the only local workflow value.
CREATE TABLE "disputes" (
  "id" UUID NOT NULL,
  "merchant_id" UUID NOT NULL,
  "environment" TEXT NOT NULL DEFAULT 'sandbox',
  "paypal_dispute_id" VARCHAR(255) NOT NULL,
  "paypal_status" VARCHAR(64) NOT NULL,
  "paypal_stage" VARCHAR(64) NOT NULL,
  "paypal_reason" VARCHAR(128) NOT NULL,
  "paypal_outcome" VARCHAR(64),
  "reason_category" VARCHAR(32) NOT NULL,
  "internal_state" VARCHAR(32) NOT NULL DEFAULT 'DETECTED',
  "currency_code" VARCHAR(3),
  "amount" DECIMAL(24,8),
  "disputed_at" TIMESTAMPTZ(3) NOT NULL,
  "deadline_at" TIMESTAMPTZ(3),
  "last_event_at" TIMESTAMPTZ(3) NOT NULL,
  "transaction_id" UUID,
  "link_status" VARCHAR(16) NOT NULL DEFAULT 'UNLINKED',
  "link_reason" VARCHAR(64),
  "source_event_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "disputes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "disputes_source_event_id_key" ON "disputes"("source_event_id");
CREATE UNIQUE INDEX "disputes_merchant_id_environment_paypal_dispute_id_key" ON "disputes"("merchant_id", "environment", "paypal_dispute_id");
CREATE INDEX "disputes_merchant_id_disputed_at_id_idx" ON "disputes"("merchant_id", "disputed_at", "id");
CREATE INDEX "disputes_merchant_id_internal_state_disputed_at_idx" ON "disputes"("merchant_id", "internal_state", "disputed_at");

ALTER TABLE "disputes" ADD CONSTRAINT "disputes_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_source_event_id_fkey" FOREIGN KEY ("source_event_id") REFERENCES "webhook_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "disputes" ADD CONSTRAINT "disputes_environment_check" CHECK ("environment" = 'sandbox');
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_status_check" CHECK ("paypal_status" IN ('OPEN', 'WAITING_FOR_BUYER_RESPONSE', 'WAITING_FOR_SELLER_RESPONSE', 'UNDER_REVIEW', 'RESOLVED', 'OTHER'));
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_stage_check" CHECK ("paypal_stage" IN ('INQUIRY', 'CHARGEBACK', 'PRE_ARBITRATION', 'ARBITRATION', 'OTHER'));
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_reason_category_check" CHECK ("reason_category" IN ('ITEM_NOT_RECEIVED', 'NOT_AS_DESCRIBED', 'UNAUTHORIZED', 'DUPLICATE', 'OTHER'));
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_internal_state_check" CHECK ("internal_state" IN ('DETECTED', 'LINKED', 'NEEDS_REVIEW', 'RESOLVED_WON', 'RESOLVED_LOST', 'CLOSED'));
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_link_status_check" CHECK ("link_status" IN ('LINKED', 'UNLINKED', 'CONFLICT'));
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_amount_check" CHECK (("currency_code" IS NULL AND "amount" IS NULL) OR ("currency_code" ~ '^[A-Z]{3}$' AND "amount" > 0));

CREATE TABLE "dispute_events" (
  "id" UUID NOT NULL,
  "dispute_id" UUID NOT NULL,
  "event_id" UUID NOT NULL,
  "event_type" VARCHAR(128) NOT NULL,
  "paypal_event_id" VARCHAR(255) NOT NULL,
  "outcome" VARCHAR(32) NOT NULL DEFAULT 'APPLIED',
  "reason" VARCHAR(64),
  "occurred_at" TIMESTAMPTZ(3) NOT NULL,
  "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dispute_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "dispute_events_event_id_key" ON "dispute_events"("event_id");
CREATE INDEX "dispute_events_dispute_id_occurred_at_id_idx" ON "dispute_events"("dispute_id", "occurred_at", "id");

ALTER TABLE "dispute_events" ADD CONSTRAINT "dispute_events_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "disputes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dispute_events" ADD CONSTRAINT "dispute_events_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "webhook_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dispute_events" ADD CONSTRAINT "dispute_events_outcome_check" CHECK ("outcome" IN ('APPLIED', 'IGNORED_STALE', 'IGNORED_DUPLICATE'));

-- Public Supabase clients get no direct policies on M07 storage.
ALTER TABLE "disputes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dispute_events" ENABLE ROW LEVEL SECURITY;
