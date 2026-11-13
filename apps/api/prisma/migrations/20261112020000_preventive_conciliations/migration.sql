CREATE TABLE "conciliation_policies" (
  "merchant_id" UUID PRIMARY KEY REFERENCES "merchants"("id") ON DELETE RESTRICT,
  "settings" JSONB NOT NULL, "version" INTEGER NOT NULL DEFAULT 1,
  "updated_at" TIMESTAMPTZ(3) NOT NULL
);
CREATE TABLE "conciliation_chats" (
  "id" UUID PRIMARY KEY, "merchant_id" UUID NOT NULL REFERENCES "merchants"("id") ON DELETE RESTRICT,
  "order_id" UUID, "transaction_id" UUID, "order_reference" VARCHAR(255) NOT NULL,
  "token_hash" VARCHAR(64) NOT NULL UNIQUE, "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "revoked_at" TIMESTAMPTZ(3), "state" VARCHAR(24) NOT NULL DEFAULT 'WAITING',
  "category" VARCHAR(24) NOT NULL DEFAULT 'OTHER',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "conciliation_chats_id_merchant_id_key" UNIQUE ("id", "merchant_id"),
  CONSTRAINT "conciliation_chat_commerce_reference_check" CHECK ("order_id" IS NOT NULL OR "transaction_id" IS NOT NULL)
);
CREATE INDEX "conciliation_chats_merchant_id_updated_at_id_idx" ON "conciliation_chats"("merchant_id", "updated_at", "id");
CREATE TABLE "conciliation_messages" (
  "id" UUID PRIMARY KEY, "chat_id" UUID NOT NULL, "merchant_id" UUID NOT NULL,
  "author" VARCHAR(16) NOT NULL, "sequence" INTEGER NOT NULL, "text" VARCHAR(2000) NOT NULL, "language" VARCHAR(2) NOT NULL,
  "idempotency_key" UUID NOT NULL, "response_to_id" UUID UNIQUE,
  "classification" JSONB, "draft_text" VARCHAR(1500), "plan" VARCHAR(1000),
  "draft_status" VARCHAR(24) NOT NULL DEFAULT 'NONE', "version" INTEGER NOT NULL DEFAULT 0,
  "policy_version" INTEGER, "policy_snapshot" JSONB, "approved_by" UUID, "processed_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "conciliation_messages_chat_id_merchant_id_fkey" FOREIGN KEY ("chat_id", "merchant_id") REFERENCES "conciliation_chats"("id", "merchant_id") ON DELETE RESTRICT,
  CONSTRAINT "conciliation_messages_chat_id_author_idempotency_key_key" UNIQUE ("chat_id", "author", "idempotency_key"),
  CONSTRAINT "conciliation_messages_chat_id_sequence_key" UNIQUE ("chat_id", "sequence")
);
CREATE INDEX "conciliation_messages_chat_id_created_at_id_idx" ON "conciliation_messages"("chat_id", "created_at", "id");
CREATE INDEX "conciliation_messages_merchant_id_created_at_idx" ON "conciliation_messages"("merchant_id", "created_at");
ALTER TABLE "conciliation_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "conciliation_chats" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "conciliation_messages" ENABLE ROW LEVEL SECURITY;
-- Access only through the authorized backend; no browser Data API policies.
