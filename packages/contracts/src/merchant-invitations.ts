import { z } from 'zod';
import { MerchantRoleSchema } from './merchants.js';

export const CreateMerchantInvitationSchema = z.strictObject({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  role: MerchantRoleSchema.default('VIEWER'),
});
export type CreateMerchantInvitation = z.infer<
  typeof CreateMerchantInvitationSchema
>;
export const InvitationActionSchema = z.strictObject({}).default({});
export const MerchantInvitationSchema = z.object({
  id: z.uuid(),
  merchantId: z.uuid(),
  displayName: z.string(),
  email: z.email(),
  role: MerchantRoleSchema,
  status: z.enum(['PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED', 'EXPIRED']),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  acceptedAt: z.iso.datetime().nullable(),
  deliveryStatus: z.enum([
    'PENDING',
    'PROCESSING',
    'SENT',
    'FAILED',
    'NOT_CONFIGURED',
    'UNCERTAIN',
  ]),
  emailSentAt: z.iso.datetime().nullable(),
  emailErrorCode: z.string().nullable(),
  shareUrl: z.url(),
});
export const MerchantInvitationListSchema = z.object({
  items: z.array(MerchantInvitationSchema),
});
