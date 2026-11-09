import { z } from 'zod';

export const MerchantRoleSchema = z.enum(['ADMIN', 'VIEWER']);
export type MerchantRole = z.infer<typeof MerchantRoleSchema>;

export const MerchantPolicySchema = z.object({
  allowInvestigations: z.boolean(),
  allowSubmissions: z.boolean(),
  requireMerchantApproval: z.literal(true),
});
export type MerchantPolicy = z.infer<typeof MerchantPolicySchema>;

export const UpdateMerchantSettingsSchema = z
  .strictObject({
    displayName: z.string().trim().min(1).max(120).optional(),
    allowInvestigations: z.boolean().optional(),
    allowSubmissions: z.boolean().optional(),
    requireMerchantApproval: z.literal(true).optional(),
  })
  .refine(
    (value) => Object.keys(value).length > 0,
    'At least one setting is required',
  );
export type UpdateMerchantSettings = z.infer<
  typeof UpdateMerchantSettingsSchema
>;

export const MerchantResponseSchema = z.object({
  id: z.uuid(),
  displayName: z.string(),
  role: MerchantRoleSchema,
  policy: MerchantPolicySchema,
});
export type MerchantResponse = z.infer<typeof MerchantResponseSchema>;

export const MerchantListResponseSchema = z.object({
  items: z.array(MerchantResponseSchema),
});
export type MerchantListResponse = z.infer<typeof MerchantListResponseSchema>;

export const PayPalIntegrationSchema = z.object({
  provider: z.literal('PAYPAL'),
  environment: z.literal('sandbox'),
  credentialsConfigured: z.boolean(),
  webhookConfigured: z.boolean(),
  connectionStatus: z.enum([
    'NOT_CONFIGURED',
    'NOT_CHECKED',
    'CONNECTED',
    'INVALID_CREDENTIALS',
    'UNAVAILABLE',
  ]),
  disputesReadStatus: z.enum([
    'NOT_CHECKED',
    'AVAILABLE',
    'DENIED',
    'UNAVAILABLE',
  ]),
  lastCheckedAt: z.iso.datetime().nullable(),
  paypalHttpStatus: z.number().int().nullable(),
  paypalDebugId: z.string().nullable(),
  source: z.literal('PAYPAL_SANDBOX'),
});
export type PayPalIntegration = z.infer<typeof PayPalIntegrationSchema>;

export const IntegrationsResponseSchema = z.object({
  merchantId: z.uuid(),
  paypal: PayPalIntegrationSchema,
});
export type IntegrationsResponse = z.infer<typeof IntegrationsResponseSchema>;
