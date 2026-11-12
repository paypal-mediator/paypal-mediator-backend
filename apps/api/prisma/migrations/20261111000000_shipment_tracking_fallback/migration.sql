-- CreateTable
CREATE TABLE "shipment_tracking_jobs" (
    "transaction_id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "input" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "lease_token" UUID,
    "lease_expires_at" TIMESTAMPTZ(3),
    "last_attempt_at" TIMESTAMPTZ(3),
    "next_attempt_at" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "last_dispute_event_at" TIMESTAMPTZ(3),
    "provider_account_key" VARCHAR(64),
    "source_attempts" JSONB NOT NULL DEFAULT '[]',
    "error_code" VARCHAR(128),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "shipment_tracking_jobs_pkey" PRIMARY KEY ("transaction_id")
);

-- CreateTable
CREATE TABLE "shipment_tracking_snapshots" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "tracking_number" VARCHAR(100) NOT NULL,
    "carrier_key" VARCHAR(255) NOT NULL,
    "content_hash" VARCHAR(64) NOT NULL,
    "observation" JSONB NOT NULL,
    "original" JSONB NOT NULL,
    "evidence_id" UUID,
    "retrieved_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_tracking_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracking_registrations" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "account_key" VARCHAR(64) NOT NULL,
    "tracking_number" VARCHAR(100) NOT NULL,
    "requested_carrier" INTEGER NOT NULL DEFAULT 0,
    "parameters_hash" VARCHAR(64),
    "carrier" INTEGER,
    "origin" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "lease_token" UUID,
    "lease_expires_at" TIMESTAMPTZ(3),
    "last_result" JSONB,
    "last_checked_at" TIMESTAMPTZ(3),
    "failures" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3),
    "error_code" VARCHAR(128),
    "provider_code" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tracking_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracking_usage" (
    "merchant_id" UUID NOT NULL,
    "day" VARCHAR(10) NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "registration_attempts" INTEGER NOT NULL DEFAULT 0,
    "registrations" INTEGER NOT NULL DEFAULT 0,
    "queries" INTEGER NOT NULL DEFAULT 0,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "webhooks" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "tracking_usage_pkey" PRIMARY KEY ("merchant_id","day")
);

-- CreateTable
CREATE TABLE "tracking_api_gates" (
    "account_key" VARCHAR(64) NOT NULL,
    "next_request_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tracking_api_gates_pkey" PRIMARY KEY ("account_key")
);

-- CreateIndex
CREATE INDEX "shipment_tracking_jobs_merchant_id_next_attempt_at_idx" ON "shipment_tracking_jobs"("merchant_id", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_tracking_jobs_transaction_id_merchant_id_key" ON "shipment_tracking_jobs"("transaction_id", "merchant_id");

-- CreateIndex
CREATE INDEX "shipment_tracking_snapshots_merchant_id_transaction_id_retr_idx" ON "shipment_tracking_snapshots"("merchant_id", "transaction_id", "retrieved_at");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_tracking_snapshots_transaction_id_source_tracking__key" ON "shipment_tracking_snapshots"("transaction_id", "source", "tracking_number", "carrier_key", "content_hash");

-- CreateIndex
CREATE INDEX "tracking_registrations_account_key_tracking_number_carrier_idx" ON "tracking_registrations"("account_key", "tracking_number", "carrier");

-- CreateIndex
CREATE UNIQUE INDEX "tracking_registrations_merchant_id_account_key_tracking_num_key" ON "tracking_registrations"("merchant_id", "account_key", "tracking_number", "requested_carrier");

-- AddForeignKey
ALTER TABLE "shipment_tracking_jobs" ADD CONSTRAINT "shipment_tracking_jobs_transaction_id_merchant_id_fkey" FOREIGN KEY ("transaction_id", "merchant_id") REFERENCES "transactions"("id", "merchant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_tracking_snapshots" ADD CONSTRAINT "shipment_tracking_snapshots_transaction_id_merchant_id_fkey" FOREIGN KEY ("transaction_id", "merchant_id") REFERENCES "transactions"("id", "merchant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Private backend data. No client policies grant direct access.
ALTER TABLE "shipment_tracking_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shipment_tracking_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tracking_registrations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tracking_usage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tracking_api_gates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shipment_tracking_jobs" ADD CONSTRAINT "shipment_tracking_job_status_check" CHECK ("status" IN ('PENDING','SYNCING','CURRENT','STALE','NO_DATA','NO_TRACKING_NUMBER','NEEDS_REVIEW','FAILED','NOT_CONFIGURED'));
ALTER TABLE "shipment_tracking_jobs" ADD CONSTRAINT "shipment_tracking_job_counts_check" CHECK ("attempts" >= 0 AND "failures" >= 0);
ALTER TABLE "shipment_tracking_snapshots" ADD CONSTRAINT "shipment_tracking_snapshot_source_check" CHECK ("source" IN ('paypal','erp','17track'));
ALTER TABLE "tracking_registrations" ADD CONSTRAINT "tracking_registration_status_check" CHECK ("status" IN ('NEW','REGISTERING','UNKNOWN','REGISTERED','FAILED','STOPPED'));
ALTER TABLE "tracking_usage" ADD CONSTRAINT "tracking_usage_counts_check" CHECK ("requests" >= 0 AND "registration_attempts" >= 0 AND "registrations" >= 0 AND "queries" >= 0 AND "failures" >= 0 AND "webhooks" >= 0);

-- A tracking report is distinct from a shipping document or proof of delivery.
ALTER TABLE "evidence_items" DROP CONSTRAINT "evidence_items_type_check";
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_type_check" CHECK ("type" IN ('PAYMENT_RECORD','ORDER_RECORD','TRACKING','PROOF_OF_DELIVERY','DOCUMENT','ORDER_SOURCE_RECORD','SHIPMENT_TRACKING_RECORD'));
ALTER TABLE "evidence_items" DROP CONSTRAINT "evidence_items_provenance_type_check";
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_provenance_type_check" CHECK (
  ("type"='PAYMENT_RECORD' AND "source_kind"='PAYPAL') OR
  ("type"='ORDER_SOURCE_RECORD' AND "source_kind" IN ('PAYPAL','CONNECTED_SYSTEM')) OR
  ("type"='SHIPMENT_TRACKING_RECORD' AND "source_kind" IN ('PAYPAL','CONNECTED_SYSTEM','DEMO')) OR
  ("type"='ORDER_RECORD' AND "source_kind" IN ('PAYPAL','CONNECTED_SYSTEM','MERCHANT_INPUT','DEMO')) OR
  ("type" IN ('TRACKING','PROOF_OF_DELIVERY','DOCUMENT') AND "source_kind" IN ('MERCHANT_INPUT','DEMO'))
);
