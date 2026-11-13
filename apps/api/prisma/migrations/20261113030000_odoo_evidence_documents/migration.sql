-- M04 adds trusted connector originals. Public upload contracts still reject
-- CONNECTED_SYSTEM and PAYPAL provenance supplied by a browser.
ALTER TABLE "evidence_items" DROP CONSTRAINT "evidence_items_provenance_type_check";
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_provenance_type_check"
CHECK (
  ("type" = 'PAYMENT_RECORD' AND "source_kind" = 'PAYPAL')
  OR ("type" = 'ORDER_RECORD' AND "source_kind" IN ('PAYPAL', 'CONNECTED_SYSTEM', 'MERCHANT_INPUT', 'DEMO'))
  OR ("type" = 'ORDER_SOURCE_RECORD' AND "source_kind" IN ('PAYPAL', 'CONNECTED_SYSTEM'))
  OR ("type" = 'SHIPMENT_TRACKING_RECORD' AND "source_kind" IN ('PAYPAL', 'CONNECTED_SYSTEM', 'DEMO'))
  OR ("type" IN ('TRACKING', 'PROOF_OF_DELIVERY') AND "source_kind" IN ('MERCHANT_INPUT', 'DEMO'))
  OR ("type" = 'DOCUMENT' AND "source_kind" IN ('CONNECTED_SYSTEM', 'MERCHANT_INPUT', 'DEMO'))
);
ALTER TABLE "evidence_items" DROP CONSTRAINT "evidence_items_document_source_check";
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_document_source_check"
  CHECK ("type" <> 'DOCUMENT' OR "source_kind" IN ('CONNECTED_SYSTEM', 'MERCHANT_INPUT', 'DEMO'));
