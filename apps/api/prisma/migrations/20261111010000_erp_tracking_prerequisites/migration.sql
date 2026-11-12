-- CreateTable
CREATE TABLE IF NOT EXISTS "erp_connections" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "provider" VARCHAR(64) NOT NULL,
    "external_tenant_id" VARCHAR(255),
    "base_url" VARCHAR(1024),
    "status" VARCHAR(32) NOT NULL,
    "scopes" VARCHAR(1024),
    "last_sync_at" TIMESTAMPTZ(3),
    "last_sync_error" VARCHAR(1024),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "erp_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "erp_secrets" (
    "id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "encrypted_payload" TEXT NOT NULL,
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "rotated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "erp_secrets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "erp_sync_cursors" (
    "id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "resource" VARCHAR(64) NOT NULL,
    "cursor" VARCHAR(1024),
    "last_success_at" TIMESTAMPTZ(3),
    "last_error" VARCHAR(1024),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "erp_sync_cursors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "external_records" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "record_type" VARCHAR(64) NOT NULL,
    "external_id" VARCHAR(255) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "normalized_payload" JSONB NOT NULL,
    "source_hash" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "transaction_links" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "paypal_capture_id" VARCHAR(255) NOT NULL,
    "paypal_order_id" VARCHAR(255),
    "record_id" UUID NOT NULL,
    "match_method" VARCHAR(64) NOT NULL,
    "confidence" VARCHAR(16) NOT NULL,
    "reviewed_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transaction_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "erp_connections_merchant_id_provider_idx" ON "erp_connections"("merchant_id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "erp_secrets_connection_id_key" ON "erp_secrets"("connection_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "erp_sync_cursors_connection_id_resource_key" ON "erp_sync_cursors"("connection_id", "resource");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "external_records_merchant_id_record_type_external_id_idx" ON "external_records"("merchant_id", "record_type", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "external_records_connection_id_record_type_external_id_key" ON "external_records"("connection_id", "record_type", "external_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "transaction_links_merchant_id_paypal_capture_id_idx" ON "transaction_links"("merchant_id", "paypal_capture_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "transaction_links_merchant_id_paypal_capture_id_record_id_key" ON "transaction_links"("merchant_id", "paypal_capture_id", "record_id");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "erp_connections" ADD CONSTRAINT "erp_connections_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "erp_secrets" ADD CONSTRAINT "erp_secrets_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "erp_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "erp_sync_cursors" ADD CONSTRAINT "erp_sync_cursors_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "erp_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "external_records" ADD CONSTRAINT "external_records_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "external_records" ADD CONSTRAINT "external_records_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "erp_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "transaction_links" ADD CONSTRAINT "transaction_links_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "transaction_links" ADD CONSTRAINT "transaction_links_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "external_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The existing ERP models were not covered by the previous migration history.
-- Keep their data private; use the authorized module interfaces.
ALTER TABLE "erp_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "erp_secrets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "erp_sync_cursors" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "external_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "transaction_links" ENABLE ROW LEVEL SECURITY;
