import { z } from 'zod';

export const ContactCategorySchema = z.enum([
  'COMPLAINT',
  'QUESTION',
  'DISPUTE_INTENT',
  'COMPLIMENT',
  'THANKS',
  'OTHER',
  'UNCERTAIN',
]);
export const ContactIssueSchema = z.enum([
  'SHIPPING',
  'DEFECT',
  'RETURN',
  'GENERAL',
]);
export const ContactLanguageSchema = z.enum(['es', 'en']);
export const ContactRuleSchema = z.strictObject({
  category: z.enum(['COMPLAINT', 'QUESTION']),
  issue: ContactIssueSchema,
  automatic: z.boolean(),
  instructions: z.string().trim().max(1500),
  replyEs: z.string().trim().max(1500),
  replyEn: z.string().trim().max(1500),
});
export const ConciliationPolicySchema = z
  .strictObject({
    enabled: z.boolean(),
    // Classifier scores are not calibrated probabilities. Keep a conservative floor.
    minScore: z.number().min(0.9).max(1),
    rules: z.array(ContactRuleSchema).max(8),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.rules.forEach((rule, index) => {
      const key = `${rule.category}:${rule.issue}`;
      if (seen.has(key))
        ctx.addIssue({
          code: 'custom',
          path: ['rules', index],
          message: 'Duplicate rule',
        });
      seen.add(key);
      if (rule.automatic && (!rule.replyEs || !rule.replyEn))
        ctx.addIssue({
          code: 'custom',
          path: ['rules', index],
          message:
            'Automatic rules require approved Spanish and English replies',
        });
    });
  });
export type ConciliationPolicy = z.infer<typeof ConciliationPolicySchema>;
export const ContactClassificationSchema = z.strictObject({
  category: ContactCategorySchema,
  issue: ContactIssueSchema,
  score: z.number().min(0).max(1),
  margin: z.number().min(0).max(1),
  source: z.enum(['FAST_FILTER', 'LOCAL_NLP', 'UNAVAILABLE']),
});
export type ContactClassification = z.infer<typeof ContactClassificationSchema>;
export const ConciliationOrderSourceSchema = z.strictObject({
  kind: z.enum([
    'PAYPAL',
    'CONNECTED_SYSTEM',
    'MERCHANT_INPUT',
    'DEMO',
    'UNKNOWN',
  ]),
  system: z.string().nullable(),
  // Data provenance does not prove which checkout created the PayPal payment.
  checkoutOrigin: z.literal('UNVERIFIED'),
  receiptLinkStatus: z.literal('CHECKOUT_INTEGRATION_REQUIRED'),
});
export const CreateContactLinkSchema = z
  .strictObject({
    orderId: z.uuid().optional(),
    transactionId: z.uuid().optional(),
    expiresInDays: z.number().int().min(1).max(30).default(7),
  })
  .refine((value) => Boolean(value.orderId) !== Boolean(value.transactionId), {
    message: 'Choose one order or payment',
  });
export const ContactMessageSchema = z.strictObject({
  text: z.string().trim().min(1).max(2000),
  language: ContactLanguageSchema,
  idempotencyKey: z.uuid(),
});
export const ApproveContactReplySchema = z.strictObject({
  messageId: z.uuid(),
  expectedVersion: z.number().int().min(0),
  text: z.string().trim().min(1).max(2000),
  idempotencyKey: z.uuid(),
});
export const ContactReplyDraftSchema = z.strictObject({
  reply: z.string().trim().min(1).max(1500),
  plan: z.string().trim().min(1).max(1000),
  needsHuman: z.boolean(),
});
