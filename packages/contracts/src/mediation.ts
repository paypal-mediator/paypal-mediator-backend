import { z } from 'zod';
import { UploadEvidenceFileSchema } from './evidence.js';

export const MEDIATION_NOTICE =
  'La mediación sigue las políticas del negocio. La plataforma no mueve, retiene ni reembolsa dinero; PayPal toma la decisión financiera final.';
export const MediationStateSchema = z.enum([
  'detectado',
  'abierto',
  'en_conciliacion',
  'acuerdo',
  'sin_acuerdo',
  'demanda_admitida',
  'recopilando_pruebas',
  'dictaminado',
  'escalado_a_paypal',
  'cerrado',
]);
export type MediationState = z.infer<typeof MediationStateSchema>;
export const SolutionSchema = z.enum([
  'REPLACEMENT',
  'RESHIPMENT',
  'PARTIAL_DISCOUNT',
  'STORE_CREDIT',
  'FULL_REFUND_RECOMMENDATION',
]);
const text = z.string().trim().min(1).max(2000);
export const MediationPolicySchema = z.strictObject({
  enabled: z.boolean(),
  conciliationDays: z.number().int().min(1).max(20),
  claimHours: z.number().int().min(1).max(168),
  evidenceHours: z.number().int().min(1).max(168),
  deadlineMarginHours: z.number().int().min(1).max(72),
  returns: text,
  warranty: text,
  businessDeadlines: text,
  allowedSolutions: z
    .array(SolutionSchema)
    .min(1)
    .max(5)
    .refine((v) => new Set(v).size === v.length),
  automaticSubmission: z.boolean(),
});
export type MediationPolicy = z.infer<typeof MediationPolicySchema>;
export const ProblemSchema = z.enum([
  'DEFECTIVE_OR_NOT_AS_DESCRIBED',
  'REFUND_REQUEST',
  'SHIPPING_ERROR',
]);
export const DetectionSchema = z.strictObject({
  complaint: z.boolean(),
  type: ProblemSchema,
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  summary: text,
  confidence: z.number().min(0).max(1),
  humanReview: z.boolean(),
});
export type Detection = z.infer<typeof DetectionSchema>;
export const DetectorEnvelopeSchema = z.strictObject({
  tipo: ProblemSchema,
  gravedad: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  resumen: text,
  confianza: z.number().min(0).max(1),
  case_id: z.uuid(),
  order_id: z.string().min(1),
  paypal_transaction_id: z.string().min(1),
  origen: z.enum(['auto', 'manual']),
  reportante: z.enum(['cliente', 'vendedor']),
  monto: z.object({
    value: z.string(),
    currencyCode: z.string().regex(/^[A-Z]{3}$/),
  }),
});
export const ProposalSchema = z.strictObject({
  options: z
    .array(
      z.strictObject({
        solution: SolutionSchema,
        description: z.string().trim().min(1).max(240),
      }),
    )
    .min(1)
    .max(5),
  summary: text,
  notice: z.literal(MEDIATION_NOTICE),
  humanReview: z.boolean(),
});
export type MediationProposal = z.infer<typeof ProposalSchema>;
export const MediationVerdictSchema = z.strictObject({
  recommendation: z.enum(['BUYER', 'SELLER', 'PARTIAL']),
  evidenceBalance: z.enum([
    'EQUIVALENT',
    'CLEAR_BUYER',
    'CLEAR_SELLER',
    'MIXED',
  ]),
  summary: text,
  grounds: z
    .array(
      z.strictObject({
        statement: text,
        evidenceIds: z.array(z.string().min(1).max(128)).min(1).max(64),
      }),
    )
    .min(1)
    .max(32),
  assessedEvidence: z
    .array(
      z.strictObject({
        evidenceId: z.string().min(1).max(128),
        assessment: text,
      }),
    )
    .min(1)
    .max(256),
  notice: z.literal(MEDIATION_NOTICE),
  humanReview: z.boolean(),
});
export type MediationVerdict = z.infer<typeof MediationVerdictSchema>;
export const MediationReviewSchema = z.strictObject({
  approved: z.boolean(),
  reasons: z.array(text).min(1).max(32),
  evidenceIds: z.array(z.string().min(1).max(128)).min(1).max(256),
});
export const MediationMessageInputSchema = z.strictObject({
  idempotencyKey: z.uuid(),
  text: z.string().trim().min(1).max(1500),
});
export const MediationStartSchema = z.strictObject({
  idempotencyKey: z.uuid(),
  origin: z.enum(['auto', 'manual']),
  confirmed: z.boolean().default(false),
  type: ProblemSchema.optional(),
});
export const MediationActionSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('REVIEW'),
    idempotencyKey: z.uuid(),
    decision: z.enum(['RESUME', 'CLOSE']),
    justification: z.string().trim().min(20).max(1500),
  }),
  z.strictObject({
    action: z.literal('CONFIRM_DETECTION'),
    idempotencyKey: z.uuid(),
  }),
  z.strictObject({
    action: z.literal('ACCEPT'),
    idempotencyKey: z.uuid(),
    proposalId: z.uuid(),
    option: z.number().int().min(0).max(4),
  }),
  z.strictObject({ action: z.literal('REJECT'), idempotencyKey: z.uuid() }),
  z.strictObject({ action: z.literal('CLAIM'), idempotencyKey: z.uuid() }),
  z.strictObject({ action: z.literal('EVALUATE'), idempotencyKey: z.uuid() }),
  z.strictObject({ action: z.literal('SUBMIT'), idempotencyKey: z.uuid() }),
]);
export type MediationAction = z.infer<typeof MediationActionSchema>;
export const MediationEvidenceInputSchema = z.strictObject({
  idempotencyKey: z.uuid(),
  file: UploadEvidenceFileSchema.refine(
    (f) => f.sourceKind === 'MERCHANT_INPUT',
    'Mediation accepts real merchant evidence only',
  ),
});
export const MediationMessageSchema = z.object({
  id: z.string(),
  author: z.enum(['BUYER', 'SELLER', 'ARBITER', 'AGENT']),
  text: z.string(),
  status: z.enum([
    'RECEIVED',
    'QUEUED',
    'SENDING',
    'SENT',
    'BLOCKED',
    'UNCERTAIN',
  ]),
  createdAt: z.iso.datetime(),
});
export const MediationCaseSchema = z.object({
  id: z.uuid(),
  disputeId: z.uuid(),
  state: MediationStateSchema,
  policy: MediationPolicySchema,
  conciliationDeadline: z.iso.datetime(),
  claimDeadline: z.iso.datetime(),
  evidenceDeadline: z.iso.datetime().nullable(),
  paypalDeadline: z.iso.datetime(),
  detection: DetectionSchema.nullable(),
  proposal: z.object({ id: z.uuid(), result: ProposalSchema }).nullable(),
  sellerAccepted: z.number().int().nullable(),
  buyerAccepted: z.number().int().nullable(),
  verdict: MediationVerdictSchema.nullable(),
  humanReviewReason: z.string().nullable(),
  transitions: z.array(
    z.object({
      from: MediationStateSchema.nullable(),
      to: MediationStateSchema,
      agent: z.string(),
      reason: z.string(),
      at: z.iso.datetime(),
    }),
  ),
});
export const MediationViewSchema = z.object({
  detectorOutput: DetectorEnvelopeSchema.nullable().optional(),
  case: MediationCaseSchema.nullable(),
  messages: z.array(MediationMessageSchema),
  notice: z.literal(MEDIATION_NOTICE),
  policy: MediationPolicySchema.nullable(),
});
export type MediationView = z.infer<typeof MediationViewSchema>;
