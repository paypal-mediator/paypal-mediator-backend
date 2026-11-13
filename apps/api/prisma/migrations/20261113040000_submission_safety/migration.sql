ALTER TABLE "submissions" ADD COLUMN "request_hash" VARCHAR(64);
DROP INDEX "submissions_merchant_id_dispute_id_key";
CREATE INDEX "submissions_merchant_id_dispute_id_idx" ON "submissions" ("merchant_id", "dispute_id");
-- A dispatched or ambiguous attempt must be reconciled before another send.
CREATE UNIQUE INDEX "submissions_active_dispute_key" ON "submissions" ("merchant_id", "dispute_id")
WHERE "status" IN ('PENDING', 'UNKNOWN', 'SUBMITTED');
