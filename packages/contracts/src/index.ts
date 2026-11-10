import { z } from 'zod';
export * from './merchants.js';
export * from './event-ingestion.js';
export * from './transactions.js';
export * from './orders.js';
export * from './order-sources.js';
export * from './evidence.js';
export * from './investigations.js';
export * from './disputes.js';

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('resolve-ai-api'),
  environment: z.enum(['development', 'test', 'production']),
  timestamp: z.iso.datetime(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const ReadinessResponseSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  checks: z.object({ database: z.enum(['up', 'down']) }),
  timestamp: z.iso.datetime(),
});
export type ReadinessResponse = z.infer<typeof ReadinessResponseSchema>;

export const ApiErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  requestId: z.uuid(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export * from './submission.js';
export * from './verifications.js';
export * from './monitoring.js';
export * from './billing.js';
export * from './erp.js';
