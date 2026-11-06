-- Some deployed databases already enforce provenance by evidence type.
-- Extend that guard for originals without allowing merchant documents to claim
-- PayPal provenance. Also install the same guard on freshly migrated databases.
ALTER TABLE "evidence_items" DROP CONSTRAINT IF EXISTS "evidence_items_provenance_type_check";
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_provenance_type_check"
  CHECK (
    ("type" = 'PAYMENT_RECORD' AND "source_kind" = 'PAYPAL')
    OR
    ("type" IN ('ORDER_RECORD', 'TRACKING', 'PROOF_OF_DELIVERY', 'DOCUMENT')
      AND "source_kind" IN ('MERCHANT_INPUT', 'DEMO'))
  );
