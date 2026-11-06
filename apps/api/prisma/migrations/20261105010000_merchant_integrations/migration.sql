-- CreateEnum
CREATE TYPE "MerchantRole" AS ENUM ('ADMIN', 'VIEWER');

-- AlterTable
ALTER TABLE "merchants" ADD COLUMN     "allow_investigations" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "allow_submissions" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "require_merchant_approval" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "merchant_members" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "auth_user_id" UUID NOT NULL,
    "role" "MerchantRole" NOT NULL DEFAULT 'VIEWER',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merchant_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_integrations" (
    "merchant_id" UUID NOT NULL,
    "connection_status" TEXT NOT NULL,
    "disputes_read_status" TEXT NOT NULL,
    "credential_fingerprint" TEXT NOT NULL,
    "last_checked_at" TIMESTAMPTZ(3) NOT NULL,
    "paypal_http_status" INTEGER,
    "paypal_debug_id" TEXT,

    CONSTRAINT "merchant_integrations_pkey" PRIMARY KEY ("merchant_id")
);

-- CreateTable
CREATE TABLE "merchant_events" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merchant_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "merchant_members_auth_user_id_key" ON "merchant_members"("auth_user_id");

-- CreateIndex
CREATE INDEX "merchant_members_merchant_id_idx" ON "merchant_members"("merchant_id");

-- CreateIndex
CREATE INDEX "merchant_events_merchant_id_created_at_idx" ON "merchant_events"("merchant_id", "created_at");

-- AddForeignKey
ALTER TABLE "merchant_members" ADD CONSTRAINT "merchant_members_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_integrations" ADD CONSTRAINT "merchant_integrations_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_events" ADD CONSTRAINT "merchant_events_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- MVP policy cannot disable human approval, including through direct database writes.
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_require_approval_check" CHECK ("require_merchant_approval" = true);

-- Backend-owned tables: Supabase anon/authenticated clients get no direct policies.
-- The server database role must own these tables or have BYPASSRLS.
ALTER TABLE "merchants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "merchant_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "merchant_integrations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "merchant_events" ENABLE ROW LEVEL SECURITY;
