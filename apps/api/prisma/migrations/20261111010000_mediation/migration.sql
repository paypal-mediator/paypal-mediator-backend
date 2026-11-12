-- CreateTable
CREATE TABLE "mediation_policies" (
    "merchant_id" UUID NOT NULL,
    "record" JSONB NOT NULL,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "mediation_policies_pkey" PRIMARY KEY ("merchant_id")
);

-- CreateTable
CREATE TABLE "mediation_cases" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "dispute_id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'detectado',
    "policy" JSONB NOT NULL,
    "conciliation_deadline" TIMESTAMPTZ(3) NOT NULL,
    "claim_deadline" TIMESTAMPTZ(3) NOT NULL,
    "evidence_deadline" TIMESTAMPTZ(3),
    "paypal_deadline" TIMESTAMPTZ(3) NOT NULL,
    "detection" JSONB,
    "proposal" JSONB,
    "seller_accepted" INTEGER,
    "buyer_accepted" INTEGER,
    "verdict" JSONB,
    "packet" JSONB,
    "evidence_revision" INTEGER,
    "demand_by" TEXT,
    "human_review_reason" VARCHAR(128),
    "lease_until" TIMESTAMPTZ(3),
    "failures" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "mediation_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mediation_transitions" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "from" TEXT,
    "to" TEXT NOT NULL,
    "agent" VARCHAR(64) NOT NULL,
    "reason" VARCHAR(256) NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mediation_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mediation_messages" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "dispute_id" UUID NOT NULL,
    "source_key" VARCHAR(128) NOT NULL,
    "author" VARCHAR(16) NOT NULL,
    "text" TEXT NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'QUEUED',
    "kind" VARCHAR(32) NOT NULL DEFAULT 'MESSAGE',
    "request_hash" VARCHAR(64) NOT NULL,
    "actor_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mediation_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mediation_actions" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "dispute_id" UUID NOT NULL,
    "key" VARCHAR(128) NOT NULL,
    "hash" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mediation_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mediation_deliveries" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'QUEUED',
    "phase" VARCHAR(16) NOT NULL DEFAULT 'EVIDENCE',
    "payload_hash" VARCHAR(64) NOT NULL,
    "error_code" VARCHAR(128),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "mediation_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mediation_cases_dispute_id_key" ON "mediation_cases"("dispute_id");

-- CreateIndex
CREATE INDEX "mediation_cases_merchant_id_state_next_attempt_at_idx" ON "mediation_cases"("merchant_id", "state", "next_attempt_at");

-- CreateIndex
CREATE INDEX "mediation_transitions_case_id_at_id_idx" ON "mediation_transitions"("case_id", "at", "id");

-- CreateIndex
CREATE INDEX "mediation_messages_merchant_id_dispute_id_created_at_id_idx" ON "mediation_messages"("merchant_id", "dispute_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "mediation_messages_merchant_id_dispute_id_source_key_key" ON "mediation_messages"("merchant_id", "dispute_id", "source_key");

-- CreateIndex
CREATE UNIQUE INDEX "mediation_actions_merchant_id_dispute_id_key_key" ON "mediation_actions"("merchant_id", "dispute_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "mediation_deliveries_case_id_key" ON "mediation_deliveries"("case_id");

-- AddForeignKey
ALTER TABLE "mediation_transitions" ADD CONSTRAINT "mediation_transitions_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "mediation_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE mediation_cases ADD CONSTRAINT mediation_state_check CHECK (state IN ('detectado','abierto','en_conciliacion','acuerdo','sin_acuerdo','demanda_admitida','recopilando_pruebas','dictaminado','escalado_a_paypal','cerrado'));
ALTER TABLE mediation_messages ADD CONSTRAINT mediation_author_check CHECK (author IN ('BUYER','SELLER','ARBITER','AGENT'));
ALTER TABLE mediation_messages ADD CONSTRAINT mediation_message_size CHECK (char_length(text) <= 2000);
ALTER TABLE mediation_cases ADD CONSTRAINT mediation_deadlines_check CHECK (conciliation_deadline < claim_deadline AND claim_deadline < paypal_deadline);
ALTER TABLE mediation_messages ADD CONSTRAINT mediation_message_state_check CHECK (status IN ('RECEIVED','QUEUED','SENDING','SENT','BLOCKED','UNCERTAIN'));
ALTER TABLE mediation_cases ADD CONSTRAINT mediation_merchant_dispute_fkey FOREIGN KEY (dispute_id) REFERENCES disputes(id) ON DELETE RESTRICT;
ALTER TABLE mediation_policies ADD CONSTRAINT mediation_policy_merchant_fkey FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE RESTRICT;
ALTER TABLE mediation_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE mediation_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE mediation_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mediation_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE mediation_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mediation_deliveries ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION reject_mediation_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Mediation audit history is append-only'; END;
$$;
CREATE TRIGGER mediation_transitions_append_only BEFORE UPDATE OR DELETE ON mediation_transitions FOR EACH ROW EXECUTE FUNCTION reject_mediation_history_mutation();
CREATE TRIGGER mediation_actions_append_only BEFORE UPDATE OR DELETE ON mediation_actions FOR EACH ROW EXECUTE FUNCTION reject_mediation_history_mutation();
