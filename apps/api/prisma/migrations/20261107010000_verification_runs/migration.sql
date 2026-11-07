CREATE TABLE "verification_runs" (
  "id" UUID NOT NULL, "merchant_id" UUID NOT NULL, "transaction_id" UUID NOT NULL,
  "investigation_id" UUID NOT NULL,
  "idempotency_key" UUID NOT NULL, "actor_user_id" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RUNNING', "provider" TEXT NOT NULL,
  "model" VARCHAR(128) NOT NULL, "prompt_version" VARCHAR(64) NOT NULL,
  "evidence_revision" INTEGER NOT NULL, "snapshot" JSONB NOT NULL, "snapshot_hash" VARCHAR(64) NOT NULL,
  "result" JSONB, "result_hash" VARCHAR(64), "trace" JSONB NOT NULL, "usage" JSONB NOT NULL,
  "error_code" VARCHAR(80), "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(3) NOT NULL, "finished_at" TIMESTAMPTZ(3),
  CONSTRAINT "verification_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "verification_runs_provider_check" CHECK ("provider" IN ('NVIDIA','OPENAI')),
  CONSTRAINT "verification_runs_state_check" CHECK (
    ("status"='RUNNING' AND "result" IS NULL AND "error_code" IS NULL AND "finished_at" IS NULL)
    OR ("status"='COMPLETED' AND "result" IS NOT NULL AND "result_hash" IS NOT NULL AND "error_code" IS NULL AND "finished_at" IS NOT NULL)
    OR ("status"='FAILED' AND "result" IS NULL AND "error_code" IS NOT NULL AND "finished_at" IS NOT NULL)
  ),
  CONSTRAINT "verification_runs_revision_check" CHECK ("evidence_revision" BETWEEN 0 AND 256),
  CONSTRAINT "verification_runs_snapshot_hash_check" CHECK ("snapshot_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "verification_runs_result_hash_check" CHECK ("result_hash" IS NULL OR "result_hash" ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX "verification_runs_idempotency_key"
  ON "verification_runs"("merchant_id","investigation_id","idempotency_key");
CREATE INDEX "verification_runs_merchant_id_transaction_id_created_at_idx"
  ON "verification_runs"("merchant_id","transaction_id","created_at");
CREATE UNIQUE INDEX "verification_runs_one_active_per_transaction"
  ON "verification_runs"("merchant_id","transaction_id") WHERE "status"='RUNNING';
ALTER TABLE "verification_runs" ADD CONSTRAINT "verification_runs_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "verification_runs" ADD CONSTRAINT "verification_runs_transaction_id_merchant_id_fkey"
  FOREIGN KEY ("transaction_id","merchant_id") REFERENCES "transactions"("id","merchant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "verification_runs" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "investigation_runs" ADD CONSTRAINT "investigation_runs_id_transaction_id_merchant_id_key" UNIQUE ("id", "transaction_id", "merchant_id");
ALTER TABLE "verification_runs" ADD CONSTRAINT "verification_runs_investigation_fkey"
  FOREIGN KEY ("investigation_id", "transaction_id", "merchant_id") REFERENCES "investigation_runs"("id", "transaction_id", "merchant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
