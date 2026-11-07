import { z } from 'zod';
import { CommerceReferenceSchema, SourceKindSchema } from './orders.js';

const identity = {
  paypalCaptureId: CommerceReferenceSchema,
  merchantOrderReference: CommerceReferenceSchema,
  carrier: CommerceReferenceSchema,
  trackingNumber: CommerceReferenceSchema,
};
export const TrackingContentSchema = z.strictObject({
  ...identity,
  shippedAt: z.iso.datetime({ offset: true }),
  status: z.enum(['IN_TRANSIT', 'DELIVERED', 'CANCELLED']),
});
export const DeliveryContentSchema = z.strictObject({
  ...identity,
  deliveredAt: z.iso.datetime({ offset: true }),
  status: z.enum(['DELIVERED', 'RETRACTED']),
});
const provenance = {
  sourceKind: SourceKindSchema,
  sourceSystem: CommerceReferenceSchema,
  externalReference: CommerceReferenceSchema,
  retrievedAt: z.iso.datetime({ offset: true }),
};
export const RegisterEvidenceSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...provenance,
    type: z.literal('TRACKING'),
    content: TrackingContentSchema,
  }),
  z.strictObject({
    ...provenance,
    type: z.literal('PROOF_OF_DELIVERY'),
    content: DeliveryContentSchema,
  }),
]);
export type RegisterEvidence = z.infer<typeof RegisterEvidenceSchema>;
export const EvidenceItemResponseSchema = z.object({
  id: z.uuid(),
  type: z.enum([
    'PAYMENT_RECORD',
    'ORDER_RECORD',
    'TRACKING',
    'PROOF_OF_DELIVERY',
    'DOCUMENT',
    'ORDER_SOURCE_RECORD',
  ]),
  version: z.number().int(),
  sourceKind: z.enum(['PAYPAL', 'MERCHANT_INPUT', 'DEMO', 'CONNECTED_SYSTEM']),
  sourceSystem: z.string(),
  externalReference: z.string(),
  retrievedAt: z.iso.datetime(),
  contentHash: z.string(),
  content: z.record(z.string(), z.unknown()),
  current: z.boolean(),
  integrity: z.enum(['VALID', 'INVALID']),
});
export const EvidenceDossierResponseSchema = z.object({
  id: z.uuid(),
  merchantId: z.uuid(),
  transactionId: z.uuid(),
  revision: z.number().int(),
  items: z.array(EvidenceItemResponseSchema),
});
export const EvidenceReceiptSchema = z.object({
  outcome: z.enum(['CREATED', 'DUPLICATE']),
  evidenceId: z.uuid(),
  version: z.number().int(),
});

export const MAX_EVIDENCE_FILE_BYTES = 512 * 1024;
export const EvidenceFileMetadataSchema = z.strictObject({
  fileName: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._ -]*$/),
  mediaType: z.enum(['application/pdf', 'image/png', 'image/jpeg']),
  byteLength: z.number().int().min(1).max(MAX_EVIDENCE_FILE_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  extractedText: z.string().optional(),
});
export const UploadEvidenceFileSchema = z.strictObject({
  ...provenance,
  fileName: EvidenceFileMetadataSchema.shape.fileName,
  mediaType: EvidenceFileMetadataSchema.shape.mediaType,
  dataBase64: z
    .string()
    .min(4)
    .max(4 * Math.ceil(MAX_EVIDENCE_FILE_BYTES / 3))
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
});
export type UploadEvidenceFile = z.infer<typeof UploadEvidenceFileSchema>;
