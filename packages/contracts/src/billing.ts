import { z } from 'zod';

export const PlanResponseSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(120),
  priceCents: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  interval: z.enum(['MONTH', 'YEAR']),
  maxTransactions: z.number().int().nonnegative().nullable(),
  maxDisputes: z.number().int().nonnegative().nullable(),
  includesConciliation: z.boolean(),
  active: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type PlanResponse = z.infer<typeof PlanResponseSchema>;

export const SubscriptionResponseSchema = z.object({
  id: z.uuid(),
  merchantId: z.uuid(),
  planId: z.uuid(),
  status: z.string(),
  currentPeriodEnd: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  plan: PlanResponseSchema,
});
export type SubscriptionResponse = z.infer<typeof SubscriptionResponseSchema>;

export const CreateSubscriptionSchema = z.strictObject({
  planId: z.uuid(),
});
export type CreateSubscription = z.infer<typeof CreateSubscriptionSchema>;
