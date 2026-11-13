-- Existing duplicate memberships must be reviewed by the operator, never silently merged.
CREATE UNIQUE INDEX "merchant_members_merchant_id_auth_user_id_key"
ON "merchant_members"("merchant_id", "auth_user_id");

CREATE TABLE "merchant_invitations" (
  "id" UUID PRIMARY KEY,
  "merchant_id" UUID NOT NULL REFERENCES "merchants"("id") ON DELETE RESTRICT,
  "email" VARCHAR(254) NOT NULL,
  "role" "MerchantRole" NOT NULL DEFAULT 'VIEWER',
  "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  "created_by" UUID NOT NULL, "accepted_by" UUID, "accepted_at" TIMESTAMPTZ(3),
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  "delivery_status" VARCHAR(24) NOT NULL DEFAULT 'PENDING',
  "email_version" INTEGER NOT NULL DEFAULT 1, "email_attempts" INTEGER NOT NULL DEFAULT 0,
  "email_sent_at" TIMESTAMPTZ(3), "email_error_code" VARCHAR(80),
  "next_email_attempt_at" TIMESTAMPTZ(3), "email_lease_until" TIMESTAMPTZ(3),
  CONSTRAINT "merchant_invitations_normalized_email" CHECK ("email" = lower(btrim("email"))),
  CONSTRAINT "merchant_invitations_status_check" CHECK ("status" IN ('PENDING','ACCEPTED','DECLINED','REVOKED','EXPIRED')),
  CONSTRAINT "merchant_invitations_delivery_check" CHECK ("delivery_status" IN ('PENDING','PROCESSING','SENT','FAILED','NOT_CONFIGURED','UNCERTAIN')),
  CONSTRAINT "merchant_invitations_acceptance_check" CHECK (("status" = 'ACCEPTED') = ("accepted_at" IS NOT NULL AND "accepted_by" IS NOT NULL))
);
CREATE UNIQUE INDEX "merchant_invitations_pending_email_key"
ON "merchant_invitations"("merchant_id", "email") WHERE "status" = 'PENDING';
CREATE INDEX "merchant_invitations_email_status_expires_at_idx" ON "merchant_invitations"("email", "status", "expires_at");
CREATE INDEX "merchant_invitations_merchant_id_created_at_id_idx" ON "merchant_invitations"("merchant_id", "created_at", "id");
CREATE INDEX "merchant_invitations_delivery_status_next_email_attempt_at_idx" ON "merchant_invitations"("delivery_status", "next_email_attempt_at");
ALTER TABLE "merchant_invitations" ENABLE ROW LEVEL SECURITY;
