-- M04 stores binary originals privately; the existing JSON item stores only metadata.
ALTER TABLE "evidence_items" DROP CONSTRAINT "evidence_items_type_check";
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_type_check"
  CHECK ("type" IN ('PAYMENT_RECORD', 'ORDER_RECORD', 'TRACKING', 'PROOF_OF_DELIVERY', 'DOCUMENT'));
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_document_source_check"
  CHECK ("type" <> 'DOCUMENT' OR "source_kind" IN ('MERCHANT_INPUT', 'DEMO'));
