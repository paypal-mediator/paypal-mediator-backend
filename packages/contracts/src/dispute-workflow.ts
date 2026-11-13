import { z } from 'zod';
import { InvestigationResponseSchema } from './investigations.js';
import { VerificationResponseSchema } from './verifications.js';

export const DisputeWorkflowResponseSchema = z.strictObject({
  investigation: InvestigationResponseSchema,
  verification: VerificationResponseSchema.nullable(),
  submissionAuthorized: z.literal(false),
});
export type DisputeWorkflowResponse = z.infer<
  typeof DisputeWorkflowResponseSchema
>;
