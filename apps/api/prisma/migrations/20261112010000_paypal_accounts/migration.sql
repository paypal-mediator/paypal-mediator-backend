CREATE TABLE "paypal_accounts" (
  "merchant_id" UUID NOT NULL PRIMARY KEY REFERENCES "merchants"("id") ON DELETE RESTRICT,
  "seller_id" VARCHAR(13) UNIQUE,
  "tracking_id" UUID NOT NULL UNIQUE,
  "status" VARCHAR(24) NOT NULL DEFAULT 'PENDING',
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "checked_at" TIMESTAMPTZ(3),
  CONSTRAINT paypal_accounts_status_check CHECK (status IN ('PENDING', 'CONNECTED', 'DISCONNECTED')),
  CONSTRAINT paypal_accounts_connected_seller_check CHECK (status <> 'CONNECTED' OR seller_id IS NOT NULL)
);
ALTER TABLE "paypal_accounts" ENABLE ROW LEVEL SECURITY;
-- No browser policies: M01 checks current membership and role through NestJS.
