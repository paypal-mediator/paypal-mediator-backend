-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "merchant_order_id" UUID,
ADD COLUMN     "order_link_error" VARCHAR(64);

-- CreateTable
CREATE TABLE "merchant_orders" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'sandbox',
    "external_id" VARCHAR(255) NOT NULL,
    "paypal_order_id" VARCHAR(255),
    "source_kind" TEXT NOT NULL,
    "source_system" VARCHAR(255) NOT NULL,
    "currency_code" VARCHAR(3) NOT NULL,
    "total_amount" DECIMAL(24,8) NOT NULL,
    "shipping_amount" DECIMAL(24,8) NOT NULL,
    "tax_amount" DECIMAL(24,8) NOT NULL,
    "discount_amount" DECIMAL(24,8) NOT NULL,
    "ordered_at" TIMESTAMPTZ(3) NOT NULL,
    "items" JSONB NOT NULL,
    "content_hash" VARCHAR(64) NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merchant_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence_dossiers" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "evidence_dossiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence_items" (
    "id" UUID NOT NULL,
    "dossier_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "logical_key" VARCHAR(64) NOT NULL,
    "version" INTEGER NOT NULL,
    "source_kind" TEXT NOT NULL,
    "source_system" VARCHAR(255) NOT NULL,
    "external_reference" VARCHAR(255) NOT NULL,
    "retrieved_at" TIMESTAMPTZ(3) NOT NULL,
    "content" JSONB NOT NULL,
    "content_hash" VARCHAR(64) NOT NULL,
    "actor_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "merchant_orders_merchant_id_created_at_id_idx" ON "merchant_orders"("merchant_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_orders_merchant_id_environment_external_id_key" ON "merchant_orders"("merchant_id", "environment", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_orders_id_merchant_id_key" ON "merchant_orders"("id", "merchant_id");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_orders_merchant_id_environment_paypal_order_id_key" ON "merchant_orders"("merchant_id", "environment", "paypal_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_dossiers_transaction_id_key" ON "evidence_dossiers"("transaction_id");

-- CreateIndex
CREATE INDEX "evidence_dossiers_merchant_id_idx" ON "evidence_dossiers"("merchant_id");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_dossiers_transaction_id_merchant_id_key" ON "evidence_dossiers"("transaction_id", "merchant_id");

-- CreateIndex
CREATE INDEX "evidence_items_dossier_id_logical_key_version_idx" ON "evidence_items"("dossier_id", "logical_key", "version");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_items_dossier_id_version_key" ON "evidence_items"("dossier_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_merchant_order_id_key" ON "transactions"("merchant_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_merchant_order_id_merchant_id_key" ON "transactions"("merchant_order_id", "merchant_id");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_id_merchant_id_key" ON "transactions"("id", "merchant_id");

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_merchant_order_id_merchant_id_fkey" FOREIGN KEY ("merchant_order_id", "merchant_id") REFERENCES "merchant_orders"("id", "merchant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_orders" ADD CONSTRAINT "merchant_orders_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_dossiers" ADD CONSTRAINT "evidence_dossiers_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_dossiers" ADD CONSTRAINT "evidence_dossiers_transaction_id_merchant_id_fkey" FOREIGN KEY ("transaction_id", "merchant_id") REFERENCES "transactions"("id", "merchant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_dossier_id_fkey" FOREIGN KEY ("dossier_id") REFERENCES "evidence_dossiers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Structured, backend-owned records. Public Supabase clients have no direct policies.
ALTER TABLE "merchant_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "evidence_dossiers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "evidence_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "merchant_orders" ADD CONSTRAINT "merchant_orders_sandbox_check" CHECK ("environment" = 'sandbox');
ALTER TABLE "merchant_orders" ADD CONSTRAINT "merchant_orders_source_check" CHECK ("source_kind" IN ('MERCHANT_INPUT', 'DEMO'));
ALTER TABLE "merchant_orders" ADD CONSTRAINT "merchant_orders_amounts_check" CHECK ("total_amount" > 0 AND "shipping_amount" >= 0 AND "tax_amount" >= 0 AND "discount_amount" >= 0);
ALTER TABLE "merchant_orders" ADD CONSTRAINT "merchant_orders_currency_check" CHECK ("currency_code" ~ '^[A-Z]{3}$');
ALTER TABLE "evidence_dossiers" ADD CONSTRAINT "evidence_dossiers_revision_check" CHECK ("revision" BETWEEN 0 AND 256);
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_version_check" CHECK ("version" BETWEEN 1 AND 256);
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_type_check" CHECK ("type" IN ('PAYMENT_RECORD', 'ORDER_RECORD', 'TRACKING', 'PROOF_OF_DELIVERY'));
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_source_check" CHECK ("source_kind" IN ('PAYPAL', 'MERCHANT_INPUT', 'DEMO'));
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_payment_source_check" CHECK ("type" <> 'PAYMENT_RECORD' OR "source_kind" = 'PAYPAL');

